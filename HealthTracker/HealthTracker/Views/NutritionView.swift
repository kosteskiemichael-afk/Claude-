import SwiftUI

struct NutritionView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    targetsCard
                    mealPlanCard
                }
                .padding()
            }
            .navigationTitle("Nutrition")
            .refreshable { await appState.refreshHealthData() }
        }
    }

    private var targetsCard: some View {
        let t = appState.nutritionTargets
        return VStack(alignment: .leading, spacing: 12) {
            Text("Today's Targets").font(.headline)
            HStack {
                macroTile(label: "Calories", value: "\(t.calories)")
                macroTile(label: "Protein", value: "\(t.proteinG)g")
                macroTile(label: "Carbs", value: "\(t.carbsG)g")
                macroTile(label: "Fat", value: "\(t.fatG)g")
            }
            Text(t.rationale)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func macroTile(label: String, value: String) -> some View {
        VStack {
            Text(value).font(.title3).bold()
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var mealPlanCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What to Eat Today").font(.headline)
            ForEach(appState.mealPlan) { meal in
                VStack(alignment: .leading, spacing: 2) {
                    Text(meal.name).font(.subheadline).bold()
                    Text("\(meal.calories) kcal · \(meal.proteinG)g protein · \(meal.carbsG)g carbs · \(meal.fatG)g fat")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                Divider()
            }
            Text("Swap freely for foods you like that hit similar macros — these are starting points, not rules.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
