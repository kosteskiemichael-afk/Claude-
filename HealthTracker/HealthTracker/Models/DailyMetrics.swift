import Foundation

/// A single day's aggregated Health data, as read from HealthKit.
struct DailyMetrics: Identifiable, Codable, Equatable {
    var id: Date { date }
    var date: Date
    var steps: Double = 0
    var activeEnergyKcal: Double = 0
    var basalEnergyKcal: Double = 0
    var restingHeartRate: Double? = nil
    var weightLbs: Double? = nil
    var bodyFatPercent: Double? = nil
    var sleepHours: Double? = nil
    var workoutMinutes: Double = 0
    var workoutCount: Int = 0
}

/// Rolling summary used to drive nutrition/training decisions.
struct HealthSummary {
    var days: [DailyMetrics] = []

    var last7: [DailyMetrics] { Array(days.suffix(7)) }
    var last14: [DailyMetrics] { Array(days.suffix(14)) }

    var averageActiveEnergy7d: Double {
        average(last7.map { $0.activeEnergyKcal })
    }

    var averageBasalEnergy7d: Double {
        average(last7.map { $0.basalEnergyKcal })
    }

    var averageSteps7d: Double {
        average(last7.map { $0.steps })
    }

    var latestWeight: Double? {
        days.last(where: { $0.weightLbs != nil })?.weightLbs
    }

    var latestBodyFatPercent: Double? {
        days.last(where: { $0.bodyFatPercent != nil })?.bodyFatPercent
    }

    /// Linear-trend weekly weight change (lbs/week) over the last 14 days of weigh-ins.
    var weeklyWeightTrendLbs: Double? {
        let points = last14.compactMap { day -> (Double, Double)? in
            guard let w = day.weightLbs else { return nil }
            return (day.date.timeIntervalSince1970, w)
        }
        guard points.count >= 3 else { return nil }
        let slopePerSecond = linearRegressionSlope(points)
        return slopePerSecond * 86_400 * 7
    }

    var workoutsThisWeek: Int {
        last7.reduce(0) { $0 + $1.workoutCount }
    }

    private func average(_ values: [Double]) -> Double {
        let nonZero = values.filter { $0 > 0 }
        guard !nonZero.isEmpty else { return 0 }
        return nonZero.reduce(0, +) / Double(nonZero.count)
    }

    private func linearRegressionSlope(_ points: [(Double, Double)]) -> Double {
        let n = Double(points.count)
        let sumX = points.reduce(0) { $0 + $1.0 }
        let sumY = points.reduce(0) { $0 + $1.1 }
        let sumXY = points.reduce(0) { $0 + $1.0 * $1.1 }
        let sumX2 = points.reduce(0) { $0 + $1.0 * $1.0 }
        let denominator = n * sumX2 - sumX * sumX
        guard denominator != 0 else { return 0 }
        return (n * sumXY - sumX * sumY) / denominator
    }
}
