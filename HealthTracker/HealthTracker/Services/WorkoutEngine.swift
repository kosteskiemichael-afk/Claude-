import Foundation

struct WorkoutRecommendation {
    var today: TrainingDay
    var streakNote: String
    var weeklyWorkoutCount: Int
}

enum WorkoutEngine {
    static func recommendation(for date: Date = Date(), summary: HealthSummary) -> WorkoutRecommendation {
        let today = WorkoutProgram.day(for: date)
        let count = summary.workoutsThisWeek

        let note: String
        switch count {
        case 0:
            note = "No logged workouts yet this week — today's session matters."
        case 1...2:
            note = "\(count) workouts logged this week. Keep the streak going."
        case 3...4:
            note = "Solid week: \(count) workouts logged. On track for progressive overload."
        default:
            note = "\(count) workouts this week — make sure recovery days stay easy."
        }

        return WorkoutRecommendation(today: today, streakNote: note, weeklyWorkoutCount: count)
    }
}
