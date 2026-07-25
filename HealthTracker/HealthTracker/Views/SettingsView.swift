import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var apiKey: String = KeychainStore.loadAPIKey() ?? ""
    @State private var logWeightValue: Double = 205
    @State private var showSavedConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Profile") {
                    Stepper("Goal weight: \(Int(appState.profile.goalWeightLbs)) lbs",
                            value: $appState.profile.goalWeightLbs, in: 100...400)
                    Stepper(String(format: "Target rate: %.2f lb/week", appState.profile.targetWeeklyRateLbs),
                            value: $appState.profile.targetWeeklyRateLbs, in: -2...2, step: 0.05)
                    Picker("Goal", selection: $appState.profile.goal) {
                        ForEach(Goal.allCases) { Text($0.rawValue).tag($0) }
                    }
                }

                Section("Log Weight") {
                    HStack {
                        TextField("lbs", value: $logWeightValue, format: .number)
                            .keyboardType(.decimalPad)
                        Button("Save to Health") {
                            Task { await appState.healthKit.logWeight(pounds: logWeightValue) }
                        }
                    }
                }

                Section("AI Coach") {
                    SecureField("Anthropic API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                    Button("Save Key") {
                        KeychainStore.saveAPIKey(apiKey)
                        showSavedConfirmation = true
                    }
                    if showSavedConfirmation {
                        Text("Saved to Keychain on this device.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Health Access") {
                    Button("Re-sync Apple Health") {
                        Task { await appState.refreshHealthData() }
                    }
                    if let error = appState.healthKit.lastError {
                        Text(error).font(.caption).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
