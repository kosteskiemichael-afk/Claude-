import SwiftUI

struct CoachView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("AI Coach").font(.headline)
                        Text("Sends today's Health data and computed targets to Claude for a short, personalized note. Requires an Anthropic API key in Settings.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))

                    Button {
                        Task { await appState.requestCoachNote() }
                    } label: {
                        if appState.isLoadingCoachNote {
                            ProgressView()
                        } else {
                            Label("Get Today's Note", systemImage: "sparkles")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(appState.isLoadingCoachNote)

                    if let note = appState.coachNote {
                        Text(note)
                            .padding()
                            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                    }
                    if let error = appState.coachError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding()
            }
            .navigationTitle("Coach")
        }
    }
}
