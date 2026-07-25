import SwiftUI

@main
struct HealthTrackerApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        if appState.profile.hasOnboarded {
            ContentView()
        } else {
            OnboardingView()
        }
    }
}
