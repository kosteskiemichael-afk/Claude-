import Foundation

struct ExerciseSet: Identifiable, Codable, Equatable {
    var id: String { name }
    var name: String
    var sets: Int
    var reps: String
    var notes: String = ""
}

struct TrainingDay: Identifiable, Codable, Equatable {
    var id: String { title }
    var title: String
    var focus: String
    var exercises: [ExerciseSet]
    var cardioSuggestion: String
}

/// A 4-day upper/lower split with progressive overload, well suited to a lean bulk / recomp goal.
enum WorkoutProgram {
    static let upperA = TrainingDay(
        title: "Upper Body A (Strength)",
        focus: "Chest, back, shoulders, triceps",
        exercises: [
            ExerciseSet(name: "Barbell Bench Press", sets: 4, reps: "5-6", notes: "Add weight when you hit 6 reps on all sets"),
            ExerciseSet(name: "Weighted Pull-Ups", sets: 4, reps: "5-8"),
            ExerciseSet(name: "Seated Dumbbell Shoulder Press", sets: 3, reps: "8-10"),
            ExerciseSet(name: "Barbell Row", sets: 3, reps: "8-10"),
            ExerciseSet(name: "Cable Triceps Pushdown", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Face Pulls", sets: 3, reps: "12-15", notes: "Shoulder health")
        ],
        cardioSuggestion: "10 min incline walk to finish, optional"
    )

    static let lowerA = TrainingDay(
        title: "Lower Body A (Strength)",
        focus: "Quads, hamstrings, glutes",
        exercises: [
            ExerciseSet(name: "Barbell Back Squat", sets: 4, reps: "5-6"),
            ExerciseSet(name: "Romanian Deadlift", sets: 3, reps: "8-10"),
            ExerciseSet(name: "Walking Lunges", sets: 3, reps: "10/leg"),
            ExerciseSet(name: "Leg Press", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Standing Calf Raise", sets: 4, reps: "12-15"),
            ExerciseSet(name: "Hanging Leg Raise", sets: 3, reps: "12-15")
        ],
        cardioSuggestion: "15 min incline walk or bike, optional"
    )

    static let upperB = TrainingDay(
        title: "Upper Body B (Hypertrophy)",
        focus: "Chest, back, shoulders, arms",
        exercises: [
            ExerciseSet(name: "Incline Dumbbell Press", sets: 4, reps: "8-12"),
            ExerciseSet(name: "Chest-Supported Row", sets: 4, reps: "8-12"),
            ExerciseSet(name: "Lateral Raise", sets: 4, reps: "12-15"),
            ExerciseSet(name: "Lat Pulldown", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Barbell Curl", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Overhead Triceps Extension", sets: 3, reps: "10-12")
        ],
        cardioSuggestion: "10 min easy cardio, optional"
    )

    static let lowerB = TrainingDay(
        title: "Lower Body B (Hypertrophy)",
        focus: "Glutes, hamstrings, quads, core",
        exercises: [
            ExerciseSet(name: "Front Squat or Leg Press", sets: 4, reps: "8-10"),
            ExerciseSet(name: "Hip Thrust", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Leg Curl", sets: 3, reps: "10-12"),
            ExerciseSet(name: "Leg Extension", sets: 3, reps: "12-15"),
            ExerciseSet(name: "Seated Calf Raise", sets: 4, reps: "15-20"),
            ExerciseSet(name: "Cable Crunch", sets: 3, reps: "12-15")
        ],
        cardioSuggestion: "15-20 min steady-state cardio, recommended for fat loss"
    )

    static let restActive = TrainingDay(
        title: "Active Recovery / Rest",
        focus: "Recovery",
        exercises: [
            ExerciseSet(name: "Zone 2 walk or bike", sets: 1, reps: "20-30 min"),
            ExerciseSet(name: "Mobility / stretching", sets: 1, reps: "10-15 min")
        ],
        cardioSuggestion: "Keep it easy — this day supports recovery, not fat loss."
    )

    /// Mon/Tue/Thu/Fri training, Wed/Sat/Sun recovery — adjust to taste.
    static let weeklySchedule: [Int: TrainingDay] = [
        2: upperA,   // Monday
        3: lowerA,   // Tuesday
        4: restActive, // Wednesday
        5: upperB,   // Thursday
        6: lowerB,   // Friday
        7: restActive, // Saturday
        1: restActive  // Sunday
    ]

    static func day(for date: Date, calendar: Calendar = .current) -> TrainingDay {
        let weekday = calendar.component(.weekday, from: date)
        return weeklySchedule[weekday] ?? restActive
    }
}
