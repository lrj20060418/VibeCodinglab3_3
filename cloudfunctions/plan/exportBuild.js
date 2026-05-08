'use strict'

const SLOT_LABEL = { morning: '上午', afternoon: '下午', evening: '晚上' }

function buildPlanExportJson({ plan, places, itinerary, weatherByPlace }) {
  return {
    plan: {
      id: plan.id,
      title: plan.title,
      date: plan.date,
      budget: plan.budget,
      people_count: plan.people_count,
      preferences: plan.preferences,
    },
    places: places.map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      lng: p.lng,
      lat: p.lat,
      adcode: p.adcode,
    })),
    itinerary: itinerary.map((it) => ({
      place_id: it.place_id,
      time_slot: it.time_slot,
      sort_index: it.sort_index,
    })),
    weather_by_place: weatherByPlace,
  }
}

function buildPlanExportMd({ plan, places, itinerary, weatherByPlace }) {
  const title = plan.title || '未命名规划'
  const lines = []
  lines.push(`# ${title}`, '')
  lines.push('## 基本信息', '')
  lines.push(`- 日期：${plan.date || '—'}`)
  lines.push(`- 预算：${plan.budget != null ? `¥${plan.budget}` : '—'}`)
  lines.push(`- 人数：${plan.people_count != null ? `${plan.people_count} 人` : '—'}`)
  if (plan.preferences) lines.push(`- 偏好：${plan.preferences}`)
  lines.push('', '## 地点', '')

  if (!places.length) {
    lines.push('- （暂无地点）')
  } else {
    places.forEach((p, idx) => {
      const name = p.name || `地点 ${idx + 1}`
      const addr = p.address || '—'
      const lng = p.lng
      const lat = p.lat
      const loc =
        typeof lng === 'number' && typeof lat === 'number' ? `${lng.toFixed(6)}, ${lat.toFixed(6)}` : '—'
      const w = weatherByPlace[p.id]
      let wText = '—'
      if (w && typeof w === 'object') {
        const s = w.status || '—'
        const t = w.temperature != null ? `${w.temperature}°C` : '—'
        wText = `${s} · ${t}`
      }
      lines.push(`${idx + 1}. **${name}**`)
      lines.push(`   - 地址：${addr}`)
      lines.push(`   - 坐标：${loc}`)
      lines.push(`   - 天气：${wText}`)
    })
  }
  lines.push('', '## 行程安排', '')

  const bySlot = { morning: [], afternoon: [], evening: [] }
  const nameById = Object.fromEntries(places.map((p) => [p.id, p.name || '地点']))
  for (const it of itinerary) {
    if (bySlot[it.time_slot] && it.place_id) bySlot[it.time_slot].push(nameById[it.place_id] || it.place_id)
  }
  for (const slot of ['morning', 'afternoon', 'evening']) {
    const label = SLOT_LABEL[slot] || slot
    const items = bySlot[slot] || []
    lines.push(items.length ? `- ${label}：` + items.join('、') : `- ${label}：未安排`)
  }
  lines.push('')
  return lines.join('\n')
}

module.exports = { buildPlanExportJson, buildPlanExportMd }
