/**
 * Grade Adjusted Pace (GAP) utilities.
 *
 * Compares an athlete's ability against segment KOM difficulty
 * by normalising speeds to flat-equivalent effort.
 * Supports both running and cycling with sport-specific physics.
 */

// ── Sport configurations ────────────────────────────────────────────────────
export const SPORT_CONFIG = {
  running: {
    /** Minetti-inspired metabolic cost of grade for running */
    costFactor: (g) => 1 + 0.03 * g + 0.000175 * g * g,
    riegelBase: 1.06,
    riegelShort: 1.15,
    riegelThreshold: 1500,   // anaerobic boost below this
    riegelFloor: 400,
    effortFactor: 1.12,
    activityTypes: ['Run', 'TrailRun'],
    unit: 'pace',            // min/km
  },
  riding: {
    /** Grade cost for cycling: aero dominates on flat, gravity on climbs */
    costFactor: (g) => 1 + 0.07 * g + 0.0005 * g * g,
    riegelBase: 1.04,
    riegelShort: 1.08,
    riegelThreshold: 1000,   // short bike segments are rare
    riegelFloor: 500,
    effortFactor: 1.06,
    activityTypes: ['Ride'],
    unit: 'speed',           // km/h
  }
};

// ── Core functions ──────────────────────────────────────────────────────────

/**
 * Compute GAP speed (m/s flat-equivalent) from raw metrics.
 *
 * @param {number} distanceM   Distance in metres
 * @param {number} timeSec     Time in seconds
 * @param {number} gradePct    Average grade in percent
 * @param {string} sport       'running' or 'riding'
 * @returns {number}           GAP speed in m/s
 */
export function computeGapSpeed(distanceM, timeSec, gradePct, sport = 'running') {
  if (timeSec <= 0 || distanceM <= 0) return 0;
  const rawSpeed = distanceM / timeSec;
  const cfg = SPORT_CONFIG[sport];
  return rawSpeed * cfg.costFactor(gradePct);
}

/**
 * Riegel exponent adjusted for distance and sport.
 *
 * Below the sport's threshold, anaerobic/neuromuscular reserves let
 * athletes go disproportionately faster. A higher exponent captures this
 * (d/d_ref < 1 → higher exp → smaller ratio → shorter projected time).
 *
 * @param {number} distM  Target distance in metres
 * @param {string} sport  'running' or 'riding'
 * @returns {number}
 */
function riegelExponent(distM, sport = 'running') {
  const cfg = SPORT_CONFIG[sport];
  if (distM >= cfg.riegelThreshold) return cfg.riegelBase;
  if (distM <= cfg.riegelFloor) return cfg.riegelShort;
  const t = (distM - cfg.riegelFloor) / (cfg.riegelThreshold - cfg.riegelFloor);
  return cfg.riegelShort - t * (cfg.riegelShort - cfg.riegelBase);
}

/**
 * Project a reference time to a different distance using Riegel's formula
 * with a sport- and distance-aware exponent.
 *
 * @param {number} refTimeSec    Reference time in seconds
 * @param {number} refDistM      Reference distance in metres
 * @param {number} targetDistM   Target distance in metres
 * @param {string} sport         'running' or 'riding'
 * @returns {number}             Projected time in seconds
 */
export function riegelProject(refTimeSec, refDistM, targetDistM, sport = 'running') {
  if (refDistM <= 0 || targetDistM <= 0 || refTimeSec <= 0) return 0;
  return refTimeSec * Math.pow(targetDistM / refDistM, riegelExponent(targetDistM, sport));
}

/**
 * Build an athlete GAP profile from recent activities.
 *
 * Returns the athlete's estimated GAP speed at a reference distance of 1 km,
 * using the P85 of per-activity GAP speeds (projected to 1 km via Riegel).
 *
 * @param {Array} activities     Array of activity objects from chrome.storage
 * @param {string} sport         'running' or 'riding'
 * @param {number} [maxActivities=20]
 * @returns {{ gapSpeedRef: number, refDistM: number, count: number } | null}
 */
export function computeAthleteProfile(activities, sport = 'running', maxActivities = 20) {
  const REF_DIST_M = 1000;
  const cfg = SPORT_CONFIG[sport];

  const matched = activities
    .filter(a => cfg.activityTypes.includes(a.Type) && !a.Excluded)
    .slice(0, maxActivities);

  if (matched.length === 0) return null;

  const gapSpeeds = [];

  for (const a of matched) {
    const distKm = parseFloat(a.Distance_km);
    const elev = parseFloat(a.D_plus) || 0;
    const timeSec = hmsTotalSeconds(a.Duree);

    if (!distKm || distKm <= 0 || timeSec <= 0) continue;

    const distM = distKm * 1000;
    const avgGrade = (elev / distM) * 100;
    const gapSpeed = computeGapSpeed(distM, timeSec, avgGrade, sport);

    const gapTimeSec = distM / gapSpeed;
    const projectedTime = riegelProject(gapTimeSec, distM, REF_DIST_M, sport);
    const projectedGapSpeed = REF_DIST_M / projectedTime;

    if (isFinite(projectedGapSpeed) && projectedGapSpeed > 0) {
      gapSpeeds.push(projectedGapSpeed);
    }
  }

  if (gapSpeeds.length === 0) return null;

  // P85 — athlete's "fast but realistic" training pace
  gapSpeeds.sort((a, b) => a - b);
  const p85Index = Math.floor(gapSpeeds.length * 0.85);
  const trainingGap = gapSpeeds[Math.min(p85Index, gapSpeeds.length - 1)];

  const gapSpeedRef = trainingGap * cfg.effortFactor;

  return { gapSpeedRef, refDistM: REF_DIST_M, count: gapSpeeds.length };
}

/**
 * Compute the athlete's projected GAP speed at a given segment distance.
 *
 * @param {{ gapSpeedRef: number, refDistM: number }} profile
 * @param {number} segDistM  Segment distance in metres
 * @param {string} sport     'running' or 'riding'
 * @returns {number}         Projected GAP speed in m/s
 */
export function athleteGapAtDistance(profile, segDistM, sport = 'running') {
  const refTime = profile.refDistM / profile.gapSpeedRef;
  const projectedTime = riegelProject(refTime, profile.refDistM, segDistM, sport);
  return segDistM / projectedTime;
}

/**
 * Compute the feasibility ratio for a segment KOM vs athlete profile.
 *
 * ratio < 1  → KOM slower than athlete's projected pace (beatable)
 * ratio ≈ 1  → realistic
 * ratio > 1  → KOM faster than athlete (hard / out of reach)
 *
 * @param {number} komTimeSec    KOM time in seconds
 * @param {number} segDistM      Segment distance in metres
 * @param {number} segGradePct   Segment average grade in percent
 * @param {{ gapSpeedRef: number, refDistM: number }} profile
 * @param {string} sport         'running' or 'riding'
 * @returns {number | null}
 */
export function feasibilityRatio(komTimeSec, segDistM, segGradePct, profile, sport = 'running') {
  if (!komTimeSec || !segDistM || !profile) return null;

  const komGap = computeGapSpeed(segDistM, komTimeSec, segGradePct, sport);
  const athleteGap = athleteGapAtDistance(profile, segDistM, sport);

  if (athleteGap <= 0) return null;
  return komGap / athleteGap;
}

/**
 * Parse "HH:MM:SS" or "MM:SS" to total seconds.
 */
function hmsTotalSeconds(hms) {
  if (!hms) return 0;
  const parts = String(hms).split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}
