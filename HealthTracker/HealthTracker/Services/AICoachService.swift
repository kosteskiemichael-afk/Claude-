import Foundation

/// Optional layer on top of the rules-based NutritionEngine/WorkoutEngine: sends your
/// current stats and computed targets to Claude for a short, personalized daily coaching
/// note. Entirely optional — everything else in the app works without it. Requires the
/// user to supply their own Anthropic API key in Settings; the key is stored in the
/// Keychain and only ever sent directly to api.anthropic.com over HTTPS.
enum AICoachService {
    struct CoachContext {
        var profile: UserProfile
        var summary: HealthSummary
        var targets: NutritionTargets
        var workout: WorkoutRecommendation
    }

    enum CoachError: LocalizedError {
        case missingAPIKey
        case requestFailed(String)

        var errorDescription: String? {
            switch self {
            case .missingAPIKey:
                return "Add your Anthropic API key in Settings to enable the AI coach."
            case .requestFailed(let message):
                return message
            }
        }
    }

    static func dailyNote(context: CoachContext) async throws -> String {
        guard let apiKey = KeychainStore.loadAPIKey(), !apiKey.isEmpty else {
            throw CoachError.missingAPIKey
        }

        let prompt = buildPrompt(context: context)
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")

        let body: [String: Any] = [
            "model": "claude-sonnet-5",
            "max_tokens": 500,
            "messages": [["role": "user", "content": prompt]]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw CoachError.requestFailed(message)
        }

        let decoded = try JSONDecoder().decode(MessagesResponse.self, from: data)
        return decoded.content.first?.text ?? "No response."
    }

    private static func buildPrompt(context: CoachContext) -> String {
        let s = context.summary
        let p = context.profile
        let t = context.targets
        let w = context.workout

        return """
        You are a concise, encouraging strength & nutrition coach. Give me a short daily \
        note (under 150 words, no headers, plain prose) based on this data. Be specific \
        and practical, don't repeat the numbers back verbatim, interpret them.

        Profile: \(p.sex.rawValue), age \(p.age), height \(Int(p.heightInches)) in, \
        current weight \(Int(s.latestWeight ?? p.startWeightLbs)) lbs, goal \(Int(p.goalWeightLbs)) lbs, \
        goal type: \(p.goal.rawValue).

        Last 7 days: avg steps \(Int(s.averageSteps7d)), avg active energy \(Int(s.averageActiveEnergy7d)) kcal, \
        workouts logged \(w.weeklyWorkoutCount), weight trend \(s.weeklyWeightTrendLbs.map { String(format: "%.2f lb/week", $0) } ?? "unknown").

        Computed targets: \(t.calories) kcal, \(t.proteinG)g protein, \(t.carbsG)g carbs, \(t.fatG)g fat.
        Today's planned workout: \(w.today.title) (\(w.today.focus)).

        Tell me anything I should adjust today specifically, and one thing to watch this week.
        """
    }

    private struct MessagesResponse: Decodable {
        struct Block: Decodable { let text: String? }
        let content: [Block]
    }
}
