# Health Tracker

A native iOS app that reads your Apple Watch data automatically (via HealthKit —
Watch data syncs to the Health app on its own, this app just reads it), then
computes daily nutrition and gym targets for a body recomposition goal
(gain weight while losing fat), plus an optional AI coach for personalized notes.

Built for: 6'2", starting ~205 lbs, goal ~220 lbs, recomposition (lean bulk).
All numbers are computed live from your profile and Health data, not hardcoded,
so they'll keep working as your stats change.

## What it does

- **Dashboard** — current weight, 14-day weight trend chart, weekly steps/active
  calories/workout count, all pulled from Apple Health.
- **Nutrition** — daily calorie and macro targets (protein/carbs/fat), computed
  with Katch-McArdle (using body fat % if you have it) or Mifflin-St Jeor BMR,
  anchored to your *actual* measured energy burn from Health data rather than a
  guessed activity level. Targets auto-adjust weekly based on your real weight
  trend vs. your goal rate. Includes concrete meal suggestions that hit those
  numbers.
- **Gym** — a 4-day upper/lower progressive-overload split (auto-picks the right
  day based on today's date), with a weekly overview and a workout-streak nudge
  based on workouts you've logged.
- **Coach** — optional: sends your current stats and targets to Claude for a
  short personalized daily note. Needs your own Anthropic API key (Settings),
  stored in the iOS Keychain, only ever sent directly to api.anthropic.com.
- **Settings** — edit your goal weight/rate, log a weight entry back to Health,
  manage your API key.

## Requirements

- A Mac with Xcode 15+ installed.
- An iPhone (HealthKit workout/body-composition data doesn't fully work in the
  Simulator — use a real device paired with your Apple Watch).
- A free or paid Apple Developer account (free is enough to run on your own
  device for 7 days at a time; paid removes that limit).
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) to generate the `.xcodeproj`
  from `project.yml` (this repo doesn't commit the generated project file, since
  it's fully reproducible from `project.yml`).

## Setup

```bash
# 1. Install XcodeGen (one-time)
brew install xcodegen

# 2. From this directory, generate the Xcode project
cd HealthTracker
xcodegen generate

# 3. Open it
open HealthTracker.xcodeproj
```

In Xcode:

1. Select the `HealthTracker` project → target `HealthTracker` → **Signing & Capabilities**.
2. Set your **Team** (your personal Apple ID works for free-tier signing).
3. Confirm the **HealthKit** capability is present (it's pre-configured via
   `project.yml`, but Xcode sometimes wants you to re-select your team first).
4. Plug in your iPhone, select it as the run destination, hit **Run**.
5. On first launch, grant the requested Health permissions (steps, active
   energy, heart rate, weight, body fat %, workouts, sleep).

That's it — no backend, no server, everything runs on-device except the
optional AI Coach call to Claude.

## Notes on the approach

- **Why no watchOS app target?** Apple Watch data (steps, heart rate, workouts,
  active energy) is written to the shared Health store automatically once your
  Watch is paired to your phone. A phone-only app reading HealthKit sees all of
  it — a separate Watch app isn't needed unless you want on-wrist UI.
- **Why "adaptive" nutrition targets instead of a fixed number?** Generic TDEE
  formulas are frequently off by 200-400 kcal/day for a given person. This app
  anchors calories to your actual measured burn from Health data and corrects
  the surplus/deficit weekly based on your real weight trend — the same
  approach used by evidence-based coaching tools, and much more reliable for a
  recomposition goal where you don't want to overshoot fat gain.
- **Where's the code?** `HealthTracker/Services/NutritionEngine.swift` and
  `WorkoutEngine.swift` hold the core logic if you want to tune the formulas
  (e.g. protein-per-lb, surplus size, split structure).
