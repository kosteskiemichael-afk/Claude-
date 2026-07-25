import Foundation

struct NutritionTargets: Equatable {
    var calories: Int
    var proteinG: Int
    var fatG: Int
    var carbsG: Int
    var bmr: Int
    var tdee: Int
    var rationale: String
}

/// Evidence-based, adaptive nutrition targets:
///  - BMR via Katch-McArdle when body fat % is known (more accurate for recomposition),
///    otherwise Mifflin-St Jeor.
///  - TDEE anchored to the user's *actual* measured energy burn from HealthKit
///    (basal + active, 7-day average) rather than a guessed activity multiplier.
///  - Calorie target adjusted weekly based on the real weight trend vs. the goal rate,
///    the same "adaptive TDEE" approach used by evidence-based coaching apps.
enum NutritionEngine {
    static func targets(profile: UserProfile, summary: HealthSummary) -> NutritionTargets {
        let currentWeight = summary.latestWeight ?? profile.startWeightLbs
        let weightKg = currentWeight * 0.453592
        let heightCm = profile.heightInches * 2.54

        let bmr: Double
        if let bf = summary.latestBodyFatPercent {
            let leanMassKg = weightKg * (1 - bf / 100)
            bmr = 370 + 21.6 * leanMassKg
        } else {
            let sexOffset = profile.sex == .male ? 5.0 : -161.0
            bmr = 10 * weightKg + 6.25 * heightCm - 5 * Double(profile.age) + sexOffset
        }

        // Prefer measured energy burn from Health data; fall back to a moderate-activity
        // multiplier if we don't have enough Health history yet.
        let measuredBurn = summary.averageBasalEnergy7d + summary.averageActiveEnergy7d
        let tdee = measuredBurn > bmr ? measuredBurn : bmr * 1.45

        let weeklyRateLbs = adjustedWeeklyRate(profile: profile, summary: summary)
        // 1 lb of tissue change ~= 3500 kcal.
        let dailyAdjustment = (weeklyRateLbs * 3500) / 7
        var calories = tdee + dailyAdjustment

        // Guardrails: never diet harder than ~25% below TDEE, never bulk more than ~20% above.
        calories = max(tdee * 0.75, min(calories, tdee * 1.2))

        let proteinG = currentWeight * 1.0 // ~1g/lb bodyweight — high end for recomposition
        let fatG = currentWeight * 0.35
        let proteinCals = proteinG * 4
        let fatCals = fatG * 9
        let carbsG = max(0, (calories - proteinCals - fatCals) / 4)

        let rationale = rationaleText(profile: profile, summary: summary, weeklyRateLbs: weeklyRateLbs, tdee: tdee)

        return NutritionTargets(
            calories: Int(calories.rounded()),
            proteinG: Int(proteinG.rounded()),
            fatG: Int(fatG.rounded()),
            carbsG: Int(carbsG.rounded()),
            bmr: Int(bmr.rounded()),
            tdee: Int(tdee.rounded()),
            rationale: rationale
        )
    }

    /// Weekly auto-adjustment: if the user is gaining faster than the target rate,
    /// dial back the surplus (protect against excess fat gain); if flat or losing
    /// while trying to gain, increase it.
    private static func adjustedWeeklyRate(profile: UserProfile, summary: HealthSummary) -> Double {
        let target = profile.goal == .cut ? -abs(profile.targetWeeklyRateLbs)
            : profile.goal == .maintain ? 0
            : profile.targetWeeklyRateLbs

        guard let actualTrend = summary.weeklyWeightTrendLbs else { return target }

        let delta = target - actualTrend
        // Nudge halfway toward correcting the gap, capped so changes stay gentle.
        let nudge = max(-0.25, min(0.25, delta * 0.5))
        return target + nudge
    }

    private static func rationaleText(profile: UserProfile, summary: HealthSummary, weeklyRateLbs: Double, tdee: Double) -> String {
        var parts: [String] = []
        if let trend = summary.weeklyWeightTrendLbs {
            parts.append(String(format: "Your measured trend is %.2f lb/week.", trend))
        } else {
            parts.append("Not enough weigh-ins yet to compute a trend — log weight regularly for auto-adjustment.")
        }
        parts.append(String(format: "Targeting %.2f lb/week toward your %d lb goal.", weeklyRateLbs, Int(profile.goalWeightLbs)))
        parts.append(String(format: "Estimated maintenance (TDEE) is %d kcal, from your actual Health data burn where available.", Int(tdee)))
        return parts.joined(separator: " ")
    }
}
