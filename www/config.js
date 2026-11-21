(function (global) {
  "use strict";

  const Carline = global.Carline = global.Carline || {};

  Carline.CONFIG = {
    appId: "cz.carline.track",
    storageKeys: {
      profile: "carline_profile_v1",
      session: "carline_session_v1"
    },
    defaults: {
      settings: {
        sound: true,
        haptics: true,
        lang: null
      },
      profile: {
        wins: 0,
        totalLaps: 0,
        totalOffTrack: 0,
        tracksBuilt: 0,
        unlockedThemes: ["classic"],
        selectedTheme: "classic"
      }
    },
    drawing: {
      minPointDistance: 7,
      minTrackLength: 140,
      smoothingIterations: 2,
      canvasPadding: 34,
      sampleCount: 360
    },
    physics: {
      autoCruiseSpeed: 135,
      manualStartSpeed: 95,
      maxSpeed: 340,
      minSpeed: 0,
      manualDragSensitivity: 1.15,
      gForceLimit: 1.35,
      flightDurationSec: 0.42,
      dropPauseSec: 0.14,
      blinkDurationSec: 1.15,
      blinkCycles: 5,
      postCrashSpeedFactor: 0.55,
      lapWinThreshold: 1,
      minLapDeltaArc: 0.02
    },
    audio: {
      engineBaseFreq: 56,
      engineMaxFreq: 168,
      engineGain: 0.045,
      hapticCooldownMs: 140,
      soundCooldownMs: 95
    },
    ui: {
      modalGuardMs: 500
    },
    themes: [
      {
        id: "classic",
        nameKey: "themeClassic",
        reqKey: "themeReqDefault",
        requiredWins: 0
      },
      {
        id: "neon",
        nameKey: "themeNeon",
        reqKey: "themeReq1Win",
        requiredWins: 1
      },
      {
        id: "blueprint",
        nameKey: "themeBlueprint",
        reqKey: "themeReq3Wins",
        requiredWins: 3
      }
    ],
    I18N: {
      cs: {
        statWins: "Výhry",
        statLaps: "Kola",
        statOffTrack: "Vyletění",
        newTrack: "Nová dráha",
        profile: "Profil",
        modeAuto: "Auto",
        modeManual: "Manuál",
        speedLabel: "Rychlost",
        hintAuto: "Automatická bezpečná jízda",
        hintManual: "Tažením vpravo přidáte plyn, vlevo uberete",
        drawPrompt: "Nakreslete prstem smyčku autodráhy – konec se spojí se začátkem.",
        drawSub: "Křížení řadí vrstvy: 1. průchod dole, další nahoře.",
        tooShortTrack: "Tah je příliš krátký. Nakreslete delší smyčku na plochu.",
        trackReady: "Dráha je připravena. Auto stojí na Startu – zvolte Auto nebo Manuál.",
        trackReadySub: "V manuálu táhněte prstem doleva / doprava pro změnu rychlosti.",
        offTrackBanner: "Vyletění z dráhy! Auto se vrací na místo odletu.",
        winBanner: "Kolo dokončeno! Přičtena výhra do profilu.",
        profileTitle: "Profil a nastavení",
        settingsHeading: "Nastavení",
        soundToggle: "Zvuky motoru a efektů",
        hapticsToggle: "Vibrace (haptika)",
        langLabel: "Jazyk / Language",
        statsHeading: "Celkové statistiky",
        totalLapsLabel: "Celkem ujetých kol",
        totalOffTrackLabel: "Celkem vyletění",
        tracksBuiltLabel: "Postavených tratí",
        themesHeading: "Motivy (odemykání výhrami)",
        themeClassic: "Klasická autodráha",
        themeNeon: "Noční neon",
        themeBlueprint: "Technický nákres",
        themeReqDefault: "Odemčeno od začátku",
        themeReq1Win: "Vyžaduje 1 výhru",
        themeReq3Wins: "Vyžaduje 3 výhry",
        unlockedBadge: "Odemčeno",
        lockedBadge: "Zamčeno",
        useTheme: "Použít",
        activeTheme: "Aktivní",
        close: "Zavřít",
        confirmNewTitle: "Zahájit novou dráhu?",
        confirmNewBody: "Máte rozjetou partii. Opravdu chcete zahodit aktuální dráhu a nakreslit novou?",
        cancel: "Zrušit",
        confirmYes: "Ano, nová dráha"
      },
      en: {
        statWins: "Wins",
        statLaps: "Laps",
        statOffTrack: "Off-track",
        newTrack: "New Track",
        profile: "Profile",
        modeAuto: "Auto",
        modeManual: "Manual",
        speedLabel: "Speed",
        hintAuto: "Automatic safe driving",
        hintManual: "Drag right for gas, drag left to slow down",
        drawPrompt: "Draw a slot-car loop with your finger – end joins the start.",
        drawSub: "Crossings set layers: 1st pass underneath, later passes on top.",
        tooShortTrack: "Stroke is too short. Draw a longer loop across the canvas.",
        trackReady: "Track ready. Car is at Start – choose Auto or Manual.",
        trackReadySub: "In Manual mode, drag left or right to adjust speed.",
        offTrackBanner: "Off the track! Returning to the exit point.",
        winBanner: "Lap completed! Win added to your profile.",
        profileTitle: "Profile & Settings",
        settingsHeading: "Settings",
        soundToggle: "Engine & effect sounds",
        hapticsToggle: "Vibrations (haptics)",
        langLabel: "Language / Jazyk",
        statsHeading: "Lifetime stats",
        totalLapsLabel: "Total laps completed",
        totalOffTrackLabel: "Total off-track exits",
        tracksBuiltLabel: "Tracks built",
        themesHeading: "Themes (unlocked by wins)",
        themeClassic: "Classic Slot Track",
        themeNeon: "Night Neon",
        themeBlueprint: "Technical Blueprint",
        themeReqDefault: "Unlocked from start",
        themeReq1Win: "Requires 1 win",
        themeReq3Wins: "Requires 3 wins",
        unlockedBadge: "Unlocked",
        lockedBadge: "Locked",
        useTheme: "Use",
        activeTheme: "Active",
        close: "Close",
        confirmNewTitle: "Start a new track?",
        confirmNewBody: "You have an active run in progress. Discard this track and draw a new one?",
        cancel: "Cancel",
        confirmYes: "Yes, new track"
      }
    }
  };

  Carline.detectLanguage = function (preferred) {
    if (preferred === "cs" || preferred === "en") {
      return preferred;
    }
    const navLang = (global.navigator && (global.navigator.language || global.navigator.userLanguage) || "en").toLowerCase();
    return navLang.startsWith("cs") ? "cs" : "en";
  };

  Carline.getText = function (lang, key) {
    const dict = Carline.CONFIG.I18N[lang] || Carline.CONFIG.I18N.en;
    return dict[key] || Carline.CONFIG.I18N.en[key] || key;
  };
})(window);
