import SwiftUI

struct WorkoutView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    let rec = appState.workoutRecommendation
                    streakCard(rec)
                    todayCard(rec.today)
                    weekOverview
                }
                .padding()
            }
            .navigationTitle("Gym")
            .refreshable { await appState.refreshHealthData() }
        }
    }

    private func streakCard(_ rec: WorkoutRecommendation) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("This Week").font(.headline)
            Text(rec.streakNote).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func todayCard(_ day: TrainingDay) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Today: \(day.title)").font(.title3).bold()
            Text(day.focus).font(.subheadline).foregroundStyle(.secondary)
            ForEach(day.exercises) { exercise in
                HStack {
                    VStack(alignment: .leading) {
                        Text(exercise.name).font(.subheadline).bold()
                        if !exercise.notes.isEmpty {
                            Text(exercise.notes).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Text("\(exercise.sets) x \(exercise.reps)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Divider()
            }
            Label(day.cardioSuggestion, systemImage: "figure.run")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private var weekOverview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("This Week's Split").font(.headline)
            ForEach(1...7, id: \.self) { weekday in
                let calendar = Calendar.current
                let day = WorkoutProgram.weeklySchedule[weekday] ?? WorkoutProgram.restActive
                HStack {
                    Text(calendar.weekdaySymbols[weekday - 1]).font(.subheadline)
                    Spacer()
                    Text(day.title).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
