import Foundation

enum Sex: String, Codable, CaseIterable, Identifiable {
    case male, female
    var id: String { rawValue }
}

enum Goal: String, Codable, CaseIterable, Identifiable {
    case leanBulk = "Gain weight, lose fat (recomp)"
    case bulk = "Gain weight"
    case cut = "Lose fat"
    case maintain = "Maintain"
    var id: String { rawValue }
}

struct UserProfile: Codable, Equatable {
    var heightInches: Double = 74      // 6'2"
    var startWeightLbs: Double = 205
    var goalWeightLbs: Double = 220
    var age: Int = 30
    var sex: Sex = .male
    var goal: Goal = .leanBulk
    /// Target rate of weight change per week toward the goal, in lbs. Small and positive for lean bulk.
    var targetWeeklyRateLbs: Double = 0.35
    var hasOnboarded: Bool = false

    static let storageKey = "UserProfile.v1"

    static var `default`: UserProfile { UserProfile() }

    func load() -> UserProfile {
        guard let data = UserDefaults.standard.data(forKey: Self.storageKey),
              let profile = try? JSONDecoder().decode(UserProfile.self, from: data) else {
            return self
        }
        return profile
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }
}
