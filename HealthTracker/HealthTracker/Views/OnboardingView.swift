import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject var appState: AppState
    @State private var heightFeet = 6
    @State private var heightInches = 2
    @State private var weight = 205.0
    @State private var goalWeight = 220.0
    @State private var age = 30
    @State private var sex: Sex = .male
    @State private var goal: Goal = .leanBulk

    var body: some View {
        NavigationStack {
            Form {
                Section("About you") {
                    Stepper(value: $heightFeet, in: 4...7) {
                        Text("Height: \(heightFeet)'\(heightInches)\"")
                    }
                    Stepper(value: $heightInches, in: 0...11) {
                        Text("Inches: \(heightInches)")
                    }
                    Stepper(value: $age, in: 13...90) {
                        Text("Age: \(age)")
                    }
                    Picker("Sex", selection: $sex) {
                        ForEach(Sex.allCases) { Text($0.rawValue.capitalized).tag($0) }
                    }
                }
                Section("Weight") {
                    HStack {
                        Text("Current weight")
                        Spacer()
                        TextField("lbs", value: $weight, format: .number)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                    HStack {
                        Text("Goal weight")
                        Spacer()
                        TextField("lbs", value: $goalWeight, format: .number)
                            .keyboardType(.decimalPad)
                            .multilineTextAlignment(.trailing)
                    }
                }
                Section("Goal") {
                    Picker("Goal", selection: $goal) {
                        ForEach(Goal.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.inline)
                }
                Section {
                    Button("Get Started") {
                        appState.profile.heightInches = Double(heightFeet * 12 + heightInches)
                        appState.profile.startWeightLbs = weight
                        appState.profile.goalWeightLbs = goalWeight
                        appState.profile.age = age
                        appState.profile.sex = sex
                        appState.profile.goal = goal
                        appState.profile.hasOnboarded = true
                    }
                }
            }
            .navigationTitle("Set Up")
        }
    }
}
