// Předpověď počasí pro revír podle GPS z konfigurace (Open-Meteo, bez API klíče).
// Načítá se přímo v prohlížeči a ukládá na 30 minut do sessionStorage. Při chybě se počasí jen nezobrazí.
(function () {
  const CACHE_MS = 30 * 60 * 1000;
  // Kódy počasí WMO -> [ikona, popis]
  const CODES = [
    [[0], "☀", "Jasno"], [[1], "🌤", "Skoro jasno"], [[2], "⛅", "Polojasno"], [[3], "☁", "Zataženo"],
    [[45, 48], "🌫", "Mlha"], [[51, 53, 55], "🌦", "Mrholení"], [[56, 57], "🌧", "Mrznoucí mrholení"],
    [[61, 63, 65], "🌧", "Déšť"], [[66, 67], "🌧", "Mrznoucí déšť"], [[71, 73, 75, 77], "🌨", "Sněžení"],
    [[80, 81, 82], "🌦", "Přeháňky"], [[85, 86], "🌨", "Sněhové přeháňky"], [[95], "⛈", "Bouřka"], [[96, 99], "⛈", "Bouřka s kroupami"]
  ];
  const describe = (code) => { const hit = CODES.find(([codes]) => codes.includes(code)); return hit ? { icon: hit[1], label: hit[2] } : { icon: "☁", label: "Počasí" }; };

  async function forecast(revir) {
    const gps = revir && revir.gps;
    if (!gps || !Number.isFinite(Number(gps.lat)) || !Number.isFinite(Number(gps.lon))) return null;
    const key = `mistenkaWeather:${gps.lat},${gps.lon}`;
    try {
      const cached = JSON.parse(sessionStorage.getItem(key) || "null");
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.days;
    } catch { /* bez úložiště */ }
    const params = new URLSearchParams({
      latitude: gps.lat, longitude: gps.lon, timezone: "Europe/Prague", forecast_days: "16",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max"
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
    const data = await response.json();
    const d = data.daily || {};
    const days = {};
    (d.time || []).forEach((date, i) => {
      days[date] = {
        ...describe(d.weather_code[i]),
        max: Math.round(d.temperature_2m_max[i]),
        min: Math.round(d.temperature_2m_min[i]),
        precipitation: d.precipitation_probability_max?.[i] ?? null,
        wind: Math.round(d.wind_speed_10m_max?.[i] ?? 0)
      };
    });
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), days })); } catch { /* bez úložiště */ }
    return days;
  }

  window.MistenkaWeather = { forecast };
})();
