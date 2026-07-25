import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var profile: UserProfile = UserProfile.default.load() {
        didSet { profile.save() }
    }
    @Published var healthKit = HealthKitManager()
    @Published var coachNote: String?
    @Published var coachError: String?
    @Published var isLoadingCoachNote = false

    var summary: HealthSummary { healthKit.summary }

    var nutritionTargets: NutritionTargets {
        NutritionEngine.targets(profile: profile, summary: summary)
    }

    var workoutRecommendation: WorkoutRecommendation {
        WorkoutEngine.recommendation(summary: summary)
    }

    var mealPlan: [MealIdea] {
        MealLibrary.plan(forTargetCalories: nutritionTargets.calories, proteinG: nutritionTargets.proteinG)
    }

    func requestHealthAccess() async {
        await healthKit.requestAuthorization()
    }

    func refreshHealthData() async {
        await healthKit.refresh()
    }

    func requestCoachNote() async {
        isLoadingCoachNote = true
        coachError = nil
        defer { isLoadingCoachNote = false }
        do {
            let context = AICoachService.CoachContext(
                profile: profile,
                summary: summary,
                targets: nutritionTargets,
                workout: workoutRecommendation
            )
            coachNote = try await AICoachService.dailyNote(context: context)
        } catch {
            coachError = error.localizedDescription
        }
    }
}
