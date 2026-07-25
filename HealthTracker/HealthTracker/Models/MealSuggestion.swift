import Foundation

struct MealIdea: Identifiable, Codable, Equatable {
    var id: String { name }
    var name: String
    var calories: Int
    var proteinG: Int
    var carbsG: Int
    var fatG: Int
    var tag: String // "breakfast", "lunch", "dinner", "snack"
}

/// A small, high-protein meal library used to build a day of eating that hits the
/// calorie/macro targets computed by NutritionEngine. Not exhaustive — meant as
/// concrete, realistic starting points, not a rigid meal plan.
enum MealLibrary {
    static let all: [MealIdea] = [
        MealIdea(name: "Greek yogurt (2 cups) + berries + granola", calories: 420, proteinG: 40, carbsG: 45, fatG: 8, tag: "breakfast"),
        MealIdea(name: "6 egg whites + 2 whole eggs scramble + oats", calories: 520, proteinG: 42, carbsG: 50, fatG: 16, tag: "breakfast"),
        MealIdea(name: "Protein shake + banana + peanut butter", calories: 480, proteinG: 45, carbsG: 45, fatG: 14, tag: "breakfast"),
        MealIdea(name: "Chicken breast (8oz) + rice (1.5c) + veggies", calories: 620, proteinG: 60, carbsG: 65, fatG: 10, tag: "lunch"),
        MealIdea(name: "Turkey/rice bowl with avocado", calories: 650, proteinG: 50, carbsG: 60, fatG: 20, tag: "lunch"),
        MealIdea(name: "Tuna (2 cans) + whole wheat wrap + veggies", calories: 500, proteinG: 55, carbsG: 40, fatG: 12, tag: "lunch"),
        MealIdea(name: "Lean beef (8oz) + sweet potato + salad", calories: 680, proteinG: 58, carbsG: 55, fatG: 22, tag: "dinner"),
        MealIdea(name: "Salmon (6oz) + quinoa + asparagus", calories: 640, proteinG: 45, carbsG: 50, fatG: 26, tag: "dinner"),
        MealIdea(name: "Chicken thighs + pasta + marinara", calories: 700, proteinG: 50, carbsG: 70, fatG: 20, tag: "dinner"),
        MealIdea(name: "Cottage cheese (1.5c) + pineapple", calories: 280, proteinG: 30, carbsG: 30, fatG: 4, tag: "snack"),
        MealIdea(name: "Protein bar + apple", calories: 320, proteinG: 20, carbsG: 40, fatG: 9, tag: "snack"),
        MealIdea(name: "Beef jerky + mixed nuts", calories: 350, proteinG: 25, carbsG: 12, fatG: 22, tag: "snack"),
        MealIdea(name: "Whey shake + rice cakes", calories: 300, proteinG: 30, carbsG: 30, fatG: 4, tag: "snack")
    ]

    /// Greedily assembles breakfast/lunch/dinner/snack picks that best fit the remaining
    /// calorie and protein budget for the day.
    static func plan(forTargetCalories calories: Int, proteinG: Int) -> [MealIdea] {
        let slots = ["breakfast", "lunch", "dinner", "snack"]
        var remainingCalories = calories
        var remainingProtein = proteinG
        var picks: [MealIdea] = []

        for slot in slots {
            let candidates = all.filter { $0.tag == slot }
            guard !candidates.isEmpty else { continue }
            let best = candidates.min { a, b in
                let scoreA = abs(a.calories - remainingCalories / (slots.count - picks.count)) - a.proteinG * 2
                let scoreB = abs(b.calories - remainingCalories / (slots.count - picks.count)) - b.proteinG * 2
                return scoreA < scoreB
            }
            if let best {
                picks.append(best)
                remainingCalories -= best.calories
                remainingProtein -= best.proteinG
            }
        }
        return picks
    }
}
