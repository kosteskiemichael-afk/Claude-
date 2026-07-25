import SwiftUI

struct ContentView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "heart.text.square") }
            NutritionView()
                .tabItem { Label("Nutrition", systemImage: "fork.knife") }
            WorkoutView()
                .tabItem { Label("Gym", systemImage: "figure.strengthtraining.traditional") }
            CoachView()
                .tabItem { Label("Coach", systemImage: "sparkles") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .task {
            if !appState.healthKit.isAuthorized {
                await appState.requestHealthAccess()
            } else {
                await appState.refreshHealthData()
            }
        }
    }
}
