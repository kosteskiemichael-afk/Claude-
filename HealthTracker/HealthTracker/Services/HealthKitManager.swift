import Foundation
import HealthKit

@MainActor
final class HealthKitManager: ObservableObject {
    let store = HKHealthStore()

    @Published var isAuthorized = false
    @Published var summary = HealthSummary()
    @Published var lastError: String?

    private let readTypes: Set<HKObjectType> = {
        var types: Set<HKObjectType> = [
            HKObjectType.quantityType(forIdentifier: .stepCount)!,
            HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .basalEnergyBurned)!,
            HKObjectType.quantityType(forIdentifier: .restingHeartRate)!,
            HKObjectType.quantityType(forIdentifier: .bodyMass)!,
            HKObjectType.quantityType(forIdentifier: .bodyFatPercentage)!,
            HKObjectType.workoutType()
        ]
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleep)
        }
        return types
    }()

    private let writeTypes: Set<HKSampleType> = [
        HKObjectType.quantityType(forIdentifier: .bodyMass)!,
        HKObjectType.quantityType(forIdentifier: .bodyFatPercentage)!
    ]

    func requestAuthorization() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            lastError = "Health data isn't available on this device."
            return
        }
        do {
            try await store.requestAuthorization(toShare: writeTypes, read: readTypes)
            isAuthorized = true
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Pulls the last 14 days of daily-aggregated Health data.
    func refresh() async {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        guard let start = calendar.date(byAdding: .day, value: -13, to: today) else { return }

        var days: [Date: DailyMetrics] = [:]
        var cursor = start
        while cursor <= today {
            days[cursor] = DailyMetrics(date: cursor)
            cursor = calendar.date(byAdding: .day, value: 1, to: cursor)!
        }

        async let steps = dailySums(identifier: .stepCount, unit: .count(), start: start)
        async let active = dailySums(identifier: .activeEnergyBurned, unit: .kilocalorie(), start: start)
        async let basal = dailySums(identifier: .basalEnergyBurned, unit: .kilocalorie(), start: start)
        async let hr = dailyAverages(identifier: .restingHeartRate, unit: .count().unitDivided(by: .minute()), start: start)
        async let weight = dailyLatest(identifier: .bodyMass, unit: .pound(), start: start)
        async let bodyFat = dailyLatest(identifier: .bodyFatPercentage, unit: .percent(), start: start)
        async let workouts = dailyWorkouts(start: start)

        let (stepsResult, activeResult, basalResult, hrResult, weightResult, bodyFatResult, workoutResult) =
            await (steps, active, basal, hr, weight, bodyFat, workouts)

        for (date, value) in stepsResult { days[date]?.steps = value }
        for (date, value) in activeResult { days[date]?.activeEnergyKcal = value }
        for (date, value) in basalResult { days[date]?.basalEnergyKcal = value }
        for (date, value) in hrResult { days[date]?.restingHeartRate = value }
        for (date, value) in weightResult { days[date]?.weightLbs = value }
        for (date, value) in bodyFatResult { days[date]?.bodyFatPercent = value * 100 }
        for (date, (minutes, count)) in workoutResult {
            days[date]?.workoutMinutes = minutes
            days[date]?.workoutCount = count
        }

        summary = HealthSummary(days: days.keys.sorted().compactMap { days[$0] })
    }

    func logWeight(pounds: Double) async {
        guard let type = HKObjectType.quantityType(forIdentifier: .bodyMass) else { return }
        let quantity = HKQuantity(unit: .pound(), doubleValue: pounds)
        let sample = HKQuantitySample(type: type, quantity: quantity, start: Date(), end: Date())
        do {
            try await store.save(sample)
            await refresh()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: - Query helpers

    private func dailySums(identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date) async -> [Date: Double] {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return [:] }
        return await withCheckedContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
            let interval = DateComponents(day: 1)
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .cumulativeSum,
                anchorDate: Calendar.current.startOfDay(for: start),
                intervalComponents: interval
            )
            query.initialResultsHandler = { _, results, _ in
                var out: [Date: Double] = [:]
                results?.enumerateStatistics(from: start, to: Date()) { stats, _ in
                    if let sum = stats.sumQuantity() {
                        out[stats.startDate] = sum.doubleValue(for: unit)
                    }
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }

    private func dailyAverages(identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date) async -> [Date: Double] {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return [:] }
        return await withCheckedContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
            let interval = DateComponents(day: 1)
            let query = HKStatisticsCollectionQuery(
                quantityType: type,
                quantitySamplePredicate: predicate,
                options: .discreteAverage,
                anchorDate: Calendar.current.startOfDay(for: start),
                intervalComponents: interval
            )
            query.initialResultsHandler = { _, results, _ in
                var out: [Date: Double] = [:]
                results?.enumerateStatistics(from: start, to: Date()) { stats, _ in
                    if let avg = stats.averageQuantity() {
                        out[stats.startDate] = avg.doubleValue(for: unit)
                    }
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }

    private func dailyLatest(identifier: HKQuantityTypeIdentifier, unit: HKUnit, start: Date) async -> [Date: Double] {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else { return [:] }
        return await withCheckedContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, _ in
                var out: [Date: Double] = [:]
                for sample in (samples as? [HKQuantitySample]) ?? [] {
                    let day = Calendar.current.startOfDay(for: sample.startDate)
                    out[day] = sample.quantity.doubleValue(for: unit)
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }

    private func dailyWorkouts(start: Date) async -> [Date: (minutes: Double, count: Int)] {
        await withCheckedContinuation { continuation in
            let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
            let query = HKSampleQuery(sampleType: .workoutType(), predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                var out: [Date: (Double, Int)] = [:]
                for workout in (samples as? [HKWorkout]) ?? [] {
                    let day = Calendar.current.startOfDay(for: workout.startDate)
                    let minutes = workout.duration / 60
                    let existing = out[day] ?? (0, 0)
                    out[day] = (existing.0 + minutes, existing.1 + 1)
                }
                continuation.resume(returning: out)
            }
            store.execute(query)
        }
    }
}
