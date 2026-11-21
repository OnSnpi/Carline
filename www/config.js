(function (global) {
  "use strict";

  const Carline = (global.Carline = global.Carline || {});

  Carline.CONFIG = {
    appId: "cz.carline.track",
    storageKeys: {
      profile: "carline_profile_v2",
      session: "carline_session_v2"
    },
    defaults: {
      settings: {
        sound: true,
        haptics: true,
        lang: null,
        difficulty: "normal",
        lapsToWin: 3
      },
      profile: {
        wins: 0,
        masterWins: 0,
        totalLaps: 0,
        totalExits: 0,
        tracksBuilt: 0,
        unlockedThemes: ["classic"],
        selectedTheme: "classic",
        unlockedCars: ["classic_car", "formula"],
        selectedCar: "classic_car"
      }
    },
    drawing: {
      minPointDistance: 7,
      minTrackLength: 150,
      smoothingIterations: 3,
      canvasPadding: 38,
      sampleCount: 420
    },
    physics: {
      magnetGripBase: 4.6,
      magnetGripDifficulties: {
        easy: 5.8,
        normal: 4.6,
        hard: 3.6
      },
      autoCruiseMax: 220,
      autoMinCornerSpeed: 72,
      autoLookaheadRatio: 0.16,
      autoSafetyFactor: 0.72,
      manualStartSpeed: 90,
      maxSpeed: 360,
      minSpeed: 0,
      manualDragSensitivity: 1.25,
      flightDurationSec: 0.45,
      dropPauseSec: 0.14,
      blinkDurationSec: 1.2,
      blinkCycles: 5,
      postCrashSpeedFactor: 0.5
    },
    audio: {
      engineBaseFreq: 54,
      engineMaxFreq: 162,
      engineGain: 0.04,
      hapticCooldownMs: 145,
      soundCooldownMs: 95
    },
    ui: {
      modalGuardMs: 500
    },
    themes: [
      { id: "classic", nameKey: "themeClassic", reqKey: "reqStart", requiredWins: 0 },
      { id: "emerald", nameKey: "themeEmerald", reqKey: "req5Wins", requiredWins: 5 },
      { id: "tournament", nameKey: "themeTournament", reqKey: "req10Wins", requiredWins: 10 },
      { id: "royal", nameKey: "themeRoyal", reqKey: "req30Wins", requiredWins: 30 }
    ],
    carStyles: [
      { id: "classic_car", nameKey: "carClassic", reqKey: "reqStart", requiredWins: 0 },
      { id: "formula", nameKey: "carFormula", reqKey: "reqStart", requiredWins: 0 },
      { id: "prototype", nameKey: "carPrototype", reqKey: "req15Wins", requiredWins: 15 },
      { id: "neon_dot", nameKey: "carNeonDot", reqKey: "req20Wins", requiredWins: 20 }
    ],
    I18N: {
      cs: {
        winsLabel: "Výhry",
        lapsShort: "Kola",
        exitsShort: "Vyletění",
        modeAuto: "Auto",
        modeManual: "Manuál",
        speedLabel: "Rychlost",
        btnUndo: "↩ Zpět",
        btnGuide: "Návod",
        btnHint: "Rada",
        btnNewGame: "Nová hra",
        statusDraw: "Nakreslete prstem smyčku autodráhy – konec se spojí se začátkem.",
        statusTooShort: "Tah je příliš krátký. Nakreslete delší uzavřenou smyčku.",
        statusAutoDemo: "Auto: ukázková bezpečná jízda s brzděním před zatáčkami.",
        statusManualDrive: "Manuál: táhněte prstem doprava pro plyn, doleva pro zpomalení.",
        statusOffTrack: "Magnet povolil v ostré zatáčce! Auto se vrací na stopu.",
        statusLapDone: "Kolo dokončeno! Pokračujte do cíle série.",
        statusHintShown: "Rada: oranžové a červené zóny ukazují, kde před zatáčkou ubrat plyn.",
        statusHintApplied: "Rada aktivní: ukázková jízda s vykreslenými brzdnými zónami.",
        statusResetStart: "Auto vráceno zpět na startovní čáru.",
        gripOk: "MAGNET OK",
        gripWarn: "NA HRANĚ",
        gripOut: "MIMO STOPU",
        settingsTitle: "Nastavení hry",
        statWins: "Výhry",
        statMaster: "Čisté",
        statLaps: "Kola",
        statTracks: "Tratě",
        langLabel: "Jazyk",
        soundLabel: "Zvuk",
        hapticsLabel: "Vibrace",
        diffLabel: "Magnet",
        diffEasy: "Silný (snadná)",
        diffNormal: "Standardní",
        diffHard: "Sportovní (těžká)",
        lapsGoalLabel: "Kola na výhru",
        onText: "Zapnuto",
        offText: "Vypnuto",
        themesSection: "Barevné motivy",
        carsSection: "Vzhled vozu",
        reqStart: "Základní",
        req5Wins: "Za 5 výher",
        req10Wins: "Za 10 výher",
        req15Wins: "Za 15 výher",
        req20Wins: "Za 20 výher",
        req30Wins: "Za 30 výher",
        saveAndClose: "Uložit a zavřít",
        guideTitle: "Návod ke hře Carline",
        guideGoal: "Postavte vlastní klikatou autodráhu jedním tahem prstu a projeďte cílový počet kol co nejrychleji bez vyletění ze zatáček.",
        guideControlsTitle: "Ovládání stavby a jízdy:",
        guideCtrl1: "Prstem nakreslete libovolnou smyčku – po zvednutí se konec spojí se začátkem.",
        guideCtrl2: "Křížení trati určí vrstvy: první průchod vede spodem, další vrchem jako most.",
        guideCtrl3: "V režimu Manuál táhněte prstem doprava (přidat plyn) a doleva (brzdit).",
        guideCtrl4: "Tlačítko ↩ Zpět (nebo swipe zprava doleva mimo dráhu) vrátí vůz na Start.",
        guideMagnetTitle: "Autodráha s magnetem a režim Auto:",
        guideMagnetBody: "Vůz drží ve stopě středový magnet. Režim Auto předvádí ideální ukázkovou jízdu – před ostrou zatáčkou včas přibrzdí a nikdy nevykolejí. Tlačítko Rada zobrazí brzdné zóny přímo na trati.",
        guideWarnTitle: "Pozor na odstředivou sílu:",
        guideWarnBody: "Pokud vletíte do ostré zatáčky příliš agresivně pod plným plynem, magnet vůz neudrží, auto vyletí z dráhy, dopadne a po zablikání pokračuje z místa odletu.",
        guideRewards: "Za dokončené série kol získáváte výhry a odemykáte nové barevné motivy (5, 10 a 30 výher) i speciální vozy (15 a 20 výher).",
        guideGotIt: "Rozumím, hrát",
        winTitle: "Série dokončena!",
        winBadgeClean: "Mistrovská čistá jízda",
        winBadgeStandard: "Úroveň dokončena",
        winCongrats: "Skvělá jízda po vlastní dráze! Výhra byla přičtena do vašeho profilu.",
        winUnlockedPrefix: "Nově odemčeno: ",
        winStatLaps: "Ujetá kola",
        winStatExits: "Vyletění",
        winStatCrossings: "Křížení",
        winStatTotalWins: "Celkem výher",
        btnBoard: "Plocha",
        btnPlayAgain: "Hrát znovu",
        confirmNewTitle: "Zahájit novou hru?",
        confirmNewBody: "Máte rozjetou partii. Chcete zahodit aktuální dráhu a nakreslit novou?",
        btnCancel: "Zrušit",
        btnConfirmYes: "Ano, nová hra"
      },
      en: {
        winsLabel: "Wins",
        lapsShort: "Laps",
        exitsShort: "Exits",
        modeAuto: "Auto",
        modeManual: "Manual",
        speedLabel: "Speed",
        btnUndo: "↩ Undo",
        btnGuide: "Guide",
        btnHint: "Hint",
        btnNewGame: "New Game",
        statusDraw: "Draw a slot-car loop with your finger – end connects to start.",
        statusTooShort: "Stroke too short. Draw a longer closed loop.",
        statusAutoDemo: "Auto: safe demonstration drive braking before sharp turns.",
        statusManualDrive: "Manual: drag right for throttle, drag left to slow down.",
        statusOffTrack: "Magnet lost grip in a sharp turn! Returning to the track.",
        statusLapDone: "Lap completed! Keep going to finish the series.",
        statusHintShown: "Hint: orange and red zones show where to brake before turns.",
        statusHintApplied: "Hint active: demo drive with braking zones highlighted.",
        statusResetStart: "Car returned to the starting line.",
        gripOk: "MAGNET OK",
        gripWarn: "ON LIMIT",
        gripOut: "OFF TRACK",
        settingsTitle: "Game Settings",
        statWins: "Wins",
        statMaster: "Clean",
        statLaps: "Laps",
        statTracks: "Tracks",
        langLabel: "Language",
        soundLabel: "Sound",
        hapticsLabel: "Haptics",
        diffLabel: "Magnet",
        diffEasy: "Strong (Easy)",
        diffNormal: "Standard",
        diffHard: "Sport (Hard)",
        lapsGoalLabel: "Laps per win",
        onText: "On",
        offText: "Off",
        themesSection: "Color Themes",
        carsSection: "Car Style",
        reqStart: "Default",
        req5Wins: "5 wins",
        req10Wins: "10 wins",
        req15Wins: "15 wins",
        req20Wins: "20 wins",
        req30Wins: "30 wins",
        saveAndClose: "Save & Close",
        guideTitle: "How to Play Carline",
        guideGoal: "Build your own winding slot-car track in a single stroke and complete the target laps as fast as possible without flying off.",
        guideControlsTitle: "Building & Driving Controls:",
        guideCtrl1: "Draw any loop with your finger – lifting closes the end to the start.",
        guideCtrl2: "Crossings create layers: first pass goes underneath, later passes over.",
        guideCtrl3: "In Manual mode, drag right to accelerate and left to brake.",
        guideCtrl4: "Tap ↩ Undo (or swipe right-to-left outside the track) to return to Start.",
        guideMagnetTitle: "Magnetic Slot Car & Auto Mode:",
        guideMagnetBody: "A center magnet holds the car in the slot. Auto mode demonstrates safe driving—braking ahead of sharp corners so it never derails. Tap Hint to display braking zones.",
        guideWarnTitle: "Watch out for centrifugal force:",
        guideWarnBody: "Entering a tight corner too aggressively at full throttle overcomes the magnet; the car flies off, lands, blinks back on the spot, and resumes.",
        guideRewards: "Completing lap series earns wins and unlocks color themes (5, 10, 30 wins) and special car styles (15, 20 wins).",
        guideGotIt: "Got it, play",
        winTitle: "Series Complete!",
        winBadgeClean: "Master Clean Run",
        winBadgeStandard: "Level Complete",
        winCongrats: "Great driving on your custom track! A win has been added to your profile.",
        winUnlockedPrefix: "Newly unlocked: ",
        winStatLaps: "Laps",
        winStatExits: "Off-track",
        winStatCrossings: "Crossings",
        winStatTotalWins: "Total wins",
        btnBoard: "Track",
        btnPlayAgain: "Play Again",
        confirmNewTitle: "Start a new game?",
        confirmNewBody: "You have an active run in progress. Discard this track and draw a new one?",
        btnCancel: "Cancel",
        btnConfirmYes: "Yes, new game"
      }
    }
  };

  Carline.detectLanguage = function (preferred) {
    if (preferred === "cs" || preferred === "en") {
      return preferred;
    }
    const navLang = ((global.navigator && (global.navigator.language || global.navigator.userLanguage)) || "en").toLowerCase();
    return navLang.startsWith("cs") ? "cs" : "en";
  };

  Carline.getText = function (lang, key) {
    const dict = Carline.CONFIG.I18N[lang] || Carline.CONFIG.I18N.en;
    return dict[key] || Carline.CONFIG.I18N.en[key] || key;
  };
})(window);
