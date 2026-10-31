import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weatherAt, seaWindAt, rainFor } from '../../src/physics/weather.js'
import { windAt } from '../../src/physics/wind.js'
import { pressureAnomaly } from '../../src/physics/weatherNoise.js'

// Weather over a month of 6-hourly samples.
function month(lat, lon, firstDay) {
  const samples = []
  for (let d = firstDay; d < firstDay + 30; d += 0.25) samples.push(weatherAt(lat, lon, Math.floor(d), (d % 1) * 24))
  const mean = (k) => samples.reduce((s, w) => s + w[k], 0) / samples.length
  return { cover: mean('cover'), rain: mean('rain'), rainy: samples.filter(w => w.rain > 0).length / samples.length, samples }
}

test('the Sahara is clear and dry, the Southern Ocean cloudy', () => {
  const sahara = month(23, 10, 182)
  assert.ok(sahara.cover < 0.25, `Sahara cover ${sahara.cover}`)
  assert.ok(sahara.rainy < 0.05, `Sahara rainy ${sahara.rainy}`)
  const southern = month(-55, 100, 182)
  assert.ok(southern.cover > 0.65, `Southern Ocean cover ${southern.cover}`)
})

test('the monsoon brings rain to India in July but not in January', () => {
  const july = month(20, 77, 182), january = month(20, 77, 1)
  assert.ok(july.rainy > 0.3, `July rainy ${july.rainy}`)
  assert.ok(january.rainy < 0.1, `January rainy ${january.rainy}`)
})

test('lows are cloudy and highs are clear', () => {
  const samples = []
  for (let i = 0; i < 400; i++) samples.push(weatherAt(48, -30 + (i % 20), 1 + Math.floor(i / 20) * 3, 12))
  const lows = samples.filter(w => w.anomaly < -1), highs = samples.filter(w => w.anomaly > 1)
  const cover = (list) => list.reduce((s, w) => s + w.cover, 0) / list.length
  assert.ok(lows.length > 20 && highs.length > 20)
  assert.ok(cover(lows) > cover(highs) + 0.3, `lows ${cover(lows)} highs ${cover(highs)}`)
})

test('rain averages its rate while it rains', () => {
  let sum = 0, n = 0
  for (let i = 0; i < 20000; i++) {
    // z ~ standard normal (Box-Muller from a fixed sequence)
    const u = (i + 0.5) / 20000, v = ((i * 7919) % 20000 + 0.5) / 20000
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    const r = rainFor(z, 0.2, 2)
    if (r > 0) { sum += r; n++ }
  }
  assert.ok(Math.abs(n / 20000 - 0.2) < 0.02, `frequency ${n / 20000}`)
  assert.ok(Math.abs(sum / n - 2) < 0.15, `mean rate ${sum / n}`)
})

test('the weather has no jumps in place or time', () => {
  for (let lat = -60; lat <= 60; lat += 11.7) {
    const a = pressureAnomaly(lat, 179.999, 100, 6), b = pressureAnomaly(lat, -179.999, 100, 6)
    assert.ok(Math.abs(a - b) < 0.05, `date line at ${lat}`)
    for (let h = 0; h < 48; h += 1.3) {
      const d = 150 + Math.floor(h / 24)
      const p = weatherAt(lat, 30, d, h % 24), q = weatherAt(lat, 30, d, h % 24 + 1 / 60)
      assert.ok(Math.abs(p.cover - q.cover) < 0.02, `cover at ${lat}, ${h}`)
    }
  }
})

test('squalls strengthen the wind at sea; otherwise it is the wind', () => {
  let stronger = 0
  for (let i = 0; i < 200; i++) {
    const lat = 5, lon = -150 + i * 0.37, day = 100 + (i % 30)
    const sea = seaWindAt(lat, lon, day, 12), wind = windAt(lat, lon, day, 12)
    assert.ok(sea.speed >= wind.speed - 1e-9)
    if (sea.speed > wind.speed * 1.05) stronger++
  }
  assert.ok(stronger > 0, 'some squalls in the tropical Pacific')
})
