'use strict'

function buildChecks({ plan, places, itinerary, weatherByPlace }) {
  const issues = []
  const add = (level, code, title, detail = '') => {
    issues.push({ level, code, title, detail })
  }

  if (!plan.date) add('warn', 'plan.missing_date', '未填写日期')

  if (!places.length) {
    add('warn', 'places.empty', '还没有添加地点')
    return issues
  }

  const missingAdcode = places.filter((p) => !(String(p.adcode || '').trim()))
  if (missingAdcode.length) {
    add('warn', 'places.missing_adcode', '部分地点缺少 adcode', '缺少 adcode 的地点无法稳定查询天气。')
  }

  const assigned = new Set(itinerary.map((it) => it.place_id).filter(Boolean))
  const unassigned = places.filter((p) => !assigned.has(p.id))
  if (unassigned.length) {
    add('warn', 'itinerary.unassigned', '有地点未安排时间段', `未安排数量：${unassigned.length}`)
  }

  const bySlot = { morning: [], afternoon: [], evening: [] }
  for (const it of itinerary) {
    if (bySlot[it.time_slot] && it.place_id) bySlot[it.time_slot].push(it.place_id)
  }
  for (const [slot, ids] of Object.entries(bySlot)) {
    if (ids.length >= 4) {
      add('warn', 'itinerary.too_many', '单个时间段地点过多', `${slot} 安排了 ${ids.length} 个地点，可能过于紧凑。`)
    }
  }

  const budget = plan.budget
  const people = plan.people_count || 1
  if (typeof budget === 'number' && budget > 0) {
    const perPerson = budget / Math.max(1, Number(people) || 1)
    if (perPerson < 80) {
      add(
        'warn',
        'plan.low_budget',
        '人均预算偏低',
        `人均约 ¥${Math.round(perPerson)}，可能需要减少跨区移动或选择更省钱的活动。`
      )
    }
  }

  const rainPlaces = []
  for (const p of places) {
    const w = weatherByPlace[p.id]
    if (w && typeof w === 'object') {
      const s = String(w.status || '')
      if (s.includes('雨')) rainPlaces.push(p.name || '地点')
    }
  }
  if (rainPlaces.length) {
    add(
      'warn',
      'weather.rain_risk',
      '雨天出行风险',
      '部分地点天气为“雨”，建议准备雨具并考虑室内备选：' + rainPlaces.slice(0, 5).join('、')
    )
  }

  if (!issues.length) {
    add('info', 'ok', '未发现明显问题', '可以继续完善地点备注与时间安排。')
  }
  return issues
}

module.exports = { buildChecks }
