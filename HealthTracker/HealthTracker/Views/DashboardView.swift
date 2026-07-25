import SwiftUI
import Charts

struct DashboardView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    weightCard
                    weekStatsCard
                    weightChart
                }
                .padding()
            }
            .navigationTitle("Dashboard")
            .refreshable { await appState.refreshHealthData() }
        }
    }

    private var currentWeight: Double {
        appState.summary.latestWeight ?? appState.profile.startWeightLbs
    }

    private var weightCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Current Weight").font(.caption).foregroundStyle(.secondary)
            Text("\(currentWeight, specifier: "%.1f") lbs")
                .font(.system(size: 34, weight: .bold))
            HStack {
                Label("Goal: \(Int(appState.profile.goalWeightLbs)) lbs", systemImage: "target")
                Spacer()
                if let trend = appState.summary.weeklyWeightTrendLbs {
                    Label(String(format: "%+.2f lb/wk", trend), systemImage: trend >= 0 ? "arrow.up.right" : "arrow.down.right")
                        .foregroundStyle(trend >= 0 ? .green : .orange)
                }
            }
            .font(.subheadline)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var weekStatsCard: some View {
        let s = appState.summary
        return VStack(alignment: .leading, spacing: 12) {
            Text("This Week").font(.headline)
            HStack(spacing: 16) {
                statTile(title: "Avg Steps", value: "\(Int(s.averageSteps7d))")
                statTile(title: "Avg Active Kcal", value: "\(Int(s.averageActiveEnergy7d))")
                statTile(title: "Workouts", value: "\(s.workoutsThisWeek)")
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func statTile(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(.title3).bold()
            Text(title).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var weightChart: some View {
        let points = appState.summary.days.filter { $0.weightLbs != nil }
        return VStack(alignment: .leading, spacing: 8) {
            Text("Weight Trend (14d)").font(.headline)
            if points.isEmpty {
                Text("No weigh-ins yet. Log your weight from a smart scale or the Health app.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Chart(points) { day in
                    LineMark(x: .value("Date", day.date), y: .value("Weight", day.weightLbs ?? 0))
                    PointMark(x: .value("Date", day.date), y: .value("Weight", day.weightLbs ?? 0))
                }
                .frame(height: 180)
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
