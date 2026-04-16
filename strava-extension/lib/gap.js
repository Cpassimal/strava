/**
 * Grade Adjusted Pace (GAP) utilities.
 *
 * Used to compare a runner's ability against segment KOM difficulty
 * by normalising speeds to flat-equivalent effort.
 */

/**
 * Cost factor for a given grade (Minetti-inspired simplification).
 * Returns a multiplier: running at `grade`% costs `costFactor` times
 * as much effort as running on flat, so the equivalent flat speed is
 * `actual_speed * costFactor(grade)`.
 *
 * @param {number} gradePct  Average grade in percent (e.g. 5 for 5%)
 * @returns {number}
 */
export function costFactor(gradePct) {
  const g = gradePct;
  return 1 + 0.03 * g + 0.000175 * g * g;
}

/**
 * Compute GAP speed (m/s flat-equivalent) from raw metrics.
 *
 * @param {number} distanceM   Distance in metres
 * @param {number} timeSec     Time in seconds
 * @param {number} gradePct    Average grade in percent
 * @returns {number}           GAP speed in m/s
 */
export function computeGapSpeed(distanceM, timeSec, gradePct) {
  if (timeSec <= 0 || distanceM <= 0) return 0;
  const rawSpeed = distanceM / timeSec;
  return rawSpeed * costFactor(gradePct);
}

/**
 * Riegel exponent adjusted for distance.
 *
 * Standard 1.06 is calibrated for 1500m–marathon. Below 1500m the
 * anaerobic energy system lets runners go disproportionately faster,
 * which is captured by a higher exponent (d/d_ref < 1, so a higher
 * exponent produces a smaller ratio → shorter projected time → faster).
 *
 * @param {number} distM  Target distance in metres
 * @returns {number}
 */
function riegelExponent(distM) {
  if (distM >= 1500) return 1.06;
  if (distM <= 400) return 1.15;
  const t = (distM - 400) / 1100;
  return 1.15 - t * 0.09;  // 1.15 @ 400m → 1.06 @ 1500m
}

/**
 * Project a reference time to a different distance using Riegel's formula
 * with a distance-aware exponent.
 *
 * @param {number} refTimeSec    Reference time in seconds
 * @param {number} refDistM      Reference distance in metres
 * @param {number} targetDistM   Target distance in metres
 * @returns {number}             Projected time in seconds
 */
export function riegelProject(refTimeSec, refDistM, targetDistM) {
  if (refDistM <= 0 || targetDistM <= 0 || refTimeSec <= 0) return 0;
  return refTimeSec * Math.pow(targetDistM / refDistM, riegelExponent(targetDistM));
}

/**
 * Build a runner GAP profile from recent activities.
 *
 * Returns the runner's estimated GAP speed at a reference distance of 1 km,
 * using the P85 of per-activity GAP speeds (projected to 1 km via Riegel).
 *
 * @param {Array} activities  Array of activity objects from chrome.storage
 *                            Expected fields: Distance_km, Duree (HH:MM:SS), D_plus, Type
 * @param {number} [maxActivities=20]  How many recent activities to consider
 * @returns {{ gapSpeedRef: number, refDistM: number, count: number } | null}
 *          gapSpeedRef is m/s GAP at 1 km, or null if insufficient data
 */
export function computeRunnerProfile(activities, maxActivities = 20) {
  const REF_DIST_M = 1000;

  const runs = activities
    .filter(a => (a.Type === 'Run' || a.Type === 'TrailRun') && !a.Excluded)
    .slice(0, maxActivities);

  if (runs.length === 0) return null;

  const gapSpeeds = [];

  for (const a of runs) {
    const distKm = parseFloat(a.Distance_km);
    const elev = parseFloat(a.D_plus) || 0;
    const timeSec = hmsTotalSeconds(a.Duree);

    if (!distKm || distKm <= 0 || timeSec <= 0) continue;

    const distM = distKm * 1000;
    const avgGrade = (elev / distM) * 100;
    const gapSpeed = computeGapSpeed(distM, timeSec, avgGrade);

    // Project this speed to the reference distance via Riegel
    // Riegel works on time, so: t_at_ref = riegelProject(timeSec, distM, REF_DIST_M)
    // then gap_speed_at_ref = REF_DIST_M / t_at_ref * costFactor(0) = REF_DIST_M / t_at_ref
    // But we want to keep the GAP component, so we project the GAP time:
    const gapTimeSec = distM / gapSpeed; // time it would take on flat at same effort
    const projectedTime = riegelProject(gapTimeSec, distM, REF_DIST_M);
    const projectedGapSpeed = REF_DIST_M / projectedTime;

    if (isFinite(projectedGapSpeed) && projectedGapSpeed > 0) {
      gapSpeeds.push(projectedGapSpeed);
    }
  }

  if (gapSpeeds.length === 0) return null;

  // P85 — runner's "fast but realistic" training pace
  gapSpeeds.sort((a, b) => a - b);
  const p85Index = Math.floor(gapSpeeds.length * 0.85);
  const trainingGap = gapSpeeds[Math.min(p85Index, gapSpeeds.length - 1)];

  // Training-to-race correction: average training pace underestimates
  // all-out segment effort by ~10-12% (warmup, easy sections, pacing).
  const RACE_EFFORT_FACTOR = 1.12;
  const gapSpeedRef = trainingGap * RACE_EFFORT_FACTOR;

  return { gapSpeedRef, refDistM: REF_DIST_M, count: gapSpeeds.length };
}

/**
 * Compute the runner's projected GAP speed at a given segment distance.
 *
 * @param {{ gapSpeedRef: number, refDistM: number }} profile
 * @param {number} segDistM  Segment distance in metres
 * @returns {number}         Projected GAP speed in m/s
 */
export function runnerGapAtDistance(profile, segDistM) {
  // time at ref distance = refDist / gapSpeedRef
  const refTime = profile.refDistM / profile.gapSpeedRef;
  const projectedTime = riegelProject(refTime, profile.refDistM, segDistM);
  return segDistM / projectedTime;
}

/**
 * Compute the feasibility ratio for a segment KOM vs runner profile.
 *
 * ratio < 1  → KOM slower than runner's projected pace (beatable)
 * ratio ≈ 1  → realistic
 * ratio > 1  → KOM faster than runner (hard / out of reach)
 *
 * @param {number} komTimeSec    KOM time in seconds
 * @param {number} segDistM      Segment distance in metres
 * @param {number} segGradePct   Segment average grade in percent
 * @param {{ gapSpeedRef: number, refDistM: number }} profile  Runner profile
 * @returns {number | null}      Ratio, or null if data missing
 */
export function feasibilityRatio(komTimeSec, segDistM, segGradePct, profile) {
  if (!komTimeSec || !segDistM || !profile) return null;

  const komGap = computeGapSpeed(segDistM, komTimeSec, segGradePct);
  const runnerGap = runnerGapAtDistance(profile, segDistM);

  if (runnerGap <= 0) return null;
  return komGap / runnerGap;
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
