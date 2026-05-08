<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { createPlan, getPlan, listPlans, updatePlan } from '../api/plans'
import { addPlace, deletePlace, listPlaces } from '../api/places'
import { getLiveWeatherByAdcode, getPlanLiveWeathers } from '../api/weather'
import { getItinerary, saveItinerary } from '../api/itinerary'
import { generatePlanSummary } from '../api/ai'
import { exportPlan, downloadJson, downloadText } from '../api/export'
import { getPlanChecks } from '../api/checks'

const LAST_OPEN_PLAN_ID_KEY = 'lab3.lastOpenPlanId'

const plans = ref([])
const selectedPlanId = ref(null)

const listLoading = ref(false)
const planLoading = ref(false)
const saving = ref(false)

const listError = ref('')
const planError = ref('')
const saveError = ref('')
const saveSuccess = ref(false)

const form = reactive({
  title: '',
  date: '',
  budget: '',
  people_count: '',
  preferences: '',
})

const amapReady = ref(false)
const mapError = ref('')
const selectedPlace = ref(null)
const places = ref([])
const placesLoading = ref(false)
const placesError = ref('')
const addingPlace = ref(false)

const weathers = ref({})
const weatherErrors = ref({})
const weatherLoading = ref(false)
const weatherError = ref('')

const pickWeatherLoading = ref(false)
const pickWeatherError = ref('')
const pickWeather = ref(null)

const isEditingExisting = computed(() => Boolean(selectedPlanId.value))

const itineraryLoading = ref(false)
const itineraryError = ref('')
const savingItinerary = ref(false)
const slotByPlaceId = ref({})

const aiLoading = ref(false)
const aiError = ref('')
const aiSummary = ref('')

const checksLoading = ref(false)
const checksError = ref('')
const checks = ref([])

async function refreshChecks() {
  checksError.value = ''
  checks.value = []
  if (!selectedPlanId.value) return
  checksLoading.value = true
  try {
    const res = await getPlanChecks(selectedPlanId.value)
    checks.value = res.issues || []
  } catch (e) {
    checksError.value = e?.message || '规则检查失败'
  } finally {
    checksLoading.value = false
  }
}

async function runExport(format) {
  if (!selectedPlanId.value) return
  try {
    const res = await exportPlan(selectedPlanId.value, format)
    const title = form.title?.trim() || 'plan'
    if (format === 'md') {
      downloadText(`${title}.md`, res.content || '')
    } else {
      downloadJson(`${title}.json`, res.content || {})
    }
  } catch (e) {
    alert(e?.message || '导出失败')
  }
}

function todayISO() {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function resetForm() {
  form.title = ''
  form.date = todayISO()
  form.budget = ''
  form.people_count = ''
  form.preferences = ''
  planError.value = ''
  saveError.value = ''
  saveSuccess.value = false
}

function normalizePayload() {
  const payload = {
    title: form.title?.trim() || null,
    date: form.date,
    budget: form.budget === '' ? null : Number(form.budget),
    people_count: form.people_count === '' ? null : Number(form.people_count),
    preferences: form.preferences?.trim() || null,
  }

  if (payload.title === null) delete payload.title
  if (payload.budget === null) delete payload.budget
  if (payload.people_count === null) delete payload.people_count
  if (payload.preferences === null) delete payload.preferences

  return payload
}

async function refreshPlans() {
  listLoading.value = true
  listError.value = ''
  try {
    plans.value = await listPlans()
  } catch (e) {
    listError.value = e?.message || '加载规划列表失败'
    plans.value = []
  } finally {
    listLoading.value = false
  }
}

async function openPlan(planId) {
  selectedPlanId.value = planId
  localStorage.setItem(LAST_OPEN_PLAN_ID_KEY, planId)

  planLoading.value = true
  planError.value = ''
  saveError.value = ''
  saveSuccess.value = false
  try {
    const p = await getPlan(planId)
    form.title = p.title || ''
    form.date = p.date || todayISO()
    form.budget = p.budget ?? ''
    form.people_count = p.people_count ?? ''
    form.preferences = p.preferences || ''
  } catch (e) {
    planError.value = e?.message || '加载规划失败'
  } finally {
    planLoading.value = false
  }

  await refreshPlaces()
  await refreshItinerary()
  await refreshChecks()
}

function newPlan() {
  selectedPlanId.value = null
  localStorage.removeItem(LAST_OPEN_PLAN_ID_KEY)
  resetForm()
}

async function savePlan() {
  saveSuccess.value = false
  saveError.value = ''
  planError.value = ''

  if (!form.date) {
    saveError.value = '请先填写日期'
    return
  }

  const payload = normalizePayload()

  saving.value = true
  try {
    let saved
    if (isEditingExisting.value) {
      saved = await updatePlan(selectedPlanId.value, payload)
    } else {
      saved = await createPlan(payload)
      selectedPlanId.value = saved.id
      localStorage.setItem(LAST_OPEN_PLAN_ID_KEY, saved.id)
    }

    saveSuccess.value = true
    await refreshPlans()
    await refreshPlaces()
    await refreshItinerary()
    await refreshChecks()
  } catch (e) {
    saveError.value = e?.message || '保存失败'
  } finally {
    saving.value = false
  }
}

const emptyList = computed(() => !listLoading.value && !listError.value && plans.value.length === 0)
const nextStepText = computed(() => {
  if (!selectedPlanId.value) return '先保存规划，再添加地点。'
  return '已打开规划：可添加地点并安排时间段。'
})

function initAmap() {
  const key = import.meta.env.VITE_AMAP_KEY
  const jsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE

  if (!key || !jsCode) {
    mapError.value = '未配置高德地图 Key。请在 frontend/.env.local 中设置 VITE_AMAP_KEY 和 VITE_AMAP_SECURITY_JS_CODE。'
    return
  }

  if (typeof window.AMapLoader === 'undefined') {
    mapError.value = '未加载高德 AMapLoader。请检查 index.html 是否引入 loader.js。'
    return
  }

  window._AMapSecurityConfig = { securityJsCode: jsCode }

  window.AMapLoader.load({
    key,
    version: '2.0',
    plugins: ['AMap.Geocoder'],
  })
    .then((AMap) => {
      amapReady.value = true
      const map = new AMap.Map('amap', {
        zoom: 11,
        center: [121.473667, 31.230525],
        viewMode: '2D',
      })

      const geocoder = new AMap.Geocoder({ city: '全国' })
      let marker = null

      map.on('click', (e) => {
        const lng = e.lnglat.getLng()
        const lat = e.lnglat.getLat()

        if (marker) map.remove(marker)
        marker = new AMap.Marker({ position: [lng, lat] })
        map.add(marker)

        selectedPlace.value = {
          name: '选中地点',
          address: '解析中…',
          lng,
          lat,
          adcode: null,
        }
        pickWeather.value = null
        pickWeatherError.value = ''

        geocoder.getAddress([lng, lat], (status, result) => {
          if (status === 'complete' && result?.info === 'OK') {
            const addr = result.regeocode?.formattedAddress || '未知地点'
            const adcode = result.regeocode?.addressComponent?.adcode || null
            const poiName = result.regeocode?.pois?.[0]?.name
            const buildingName = result.regeocode?.addressComponent?.building?.name
            const neighborhoodName = result.regeocode?.addressComponent?.neighborhood?.name
            const name =
              poiName ||
              buildingName ||
              neighborhoodName ||
              (typeof addr === 'string' ? addr.split(' ').slice(-1)[0] : null) ||
              '选中地点'
            selectedPlace.value = {
              name,
              address: addr,
              lng,
              lat,
              adcode,
            }

            if (adcode) {
              fetchPickWeather(adcode)
            } else {
              pickWeather.value = null
              pickWeatherError.value = '缺少 adcode，无法查询天气'
            }
          } else {
            selectedPlace.value = {
              name: '选中地点',
              address: '逆地理编码失败',
              lng,
              lat,
              adcode: null,
            }
            pickWeather.value = null
            pickWeatherError.value = '逆地理编码失败，无法查询天气'
          }
        })
      })
    })
    .catch((err) => {
      console.error(err)
      mapError.value = '地图加载失败：请检查 Key/安全密钥/白名单配置。'
    })
}

async function refreshPlaces() {
  placesError.value = ''
  places.value = []
  weathers.value = {}
  weatherErrors.value = {}
  weatherError.value = ''
  if (!selectedPlanId.value) return

  placesLoading.value = true
  try {
    places.value = await listPlaces(selectedPlanId.value)
    await refreshWeathers()
  } catch (e) {
    placesError.value = e?.message || '加载地点失败'
  } finally {
    placesLoading.value = false
  }
}

async function refreshItinerary() {
  itineraryError.value = ''
  slotByPlaceId.value = {}
  if (!selectedPlanId.value) return

  itineraryLoading.value = true
  try {
    const items = await getItinerary(selectedPlanId.value)
    const map = {}
    for (const it of items) {
      map[it.place_id] = it.time_slot
    }
    slotByPlaceId.value = map
  } catch (e) {
    itineraryError.value = e?.message || '加载行程失败'
  } finally {
    itineraryLoading.value = false
  }
}

const timeSlotOptions = [
  { value: '', label: '未安排' },
  { value: 'morning', label: '上午' },
  { value: 'afternoon', label: '下午' },
  { value: 'evening', label: '晚上' },
]

function getSlot(placeId) {
  return slotByPlaceId.value?.[placeId] || ''
}

function setSlot(placeId, slot) {
  slotByPlaceId.value = { ...slotByPlaceId.value, [placeId]: slot }
}

async function saveSlots() {
  if (!selectedPlanId.value) return
  itineraryError.value = ''
  savingItinerary.value = true
  try {
    const ids = (places.value || []).map((p) => p.id)
    const items = []
    const order = { morning: 0, afternoon: 1, evening: 2 }
    for (const id of ids) {
      const slot = getSlot(id)
      if (!slot) continue
      items.push({ place_id: id, time_slot: slot, sort_index: order[slot] ?? 0 })
    }
    await saveItinerary(selectedPlanId.value, items)
    await refreshItinerary()
    await refreshChecks()
  } catch (e) {
    itineraryError.value = e?.message || '保存行程失败'
  } finally {
    savingItinerary.value = false
  }
}

function placesInSlot(slot) {
  const result = []
  for (const p of places.value || []) {
    if (getSlot(p.id) === slot) result.push(p)
  }
  return result
}

async function runAiSummary() {
  if (!selectedPlanId.value) return
  aiError.value = ''
  aiSummary.value = ''
  aiLoading.value = true
  try {
    const res = await generatePlanSummary(selectedPlanId.value, 'normal')
    aiSummary.value = res.summary || ''
  } catch (e) {
    aiError.value = e?.message || 'AI 总结生成失败'
  } finally {
    aiLoading.value = false
  }
}

async function refreshWeathers() {
  weatherError.value = ''
  weathers.value = {}
  weatherErrors.value = {}
  if (!selectedPlanId.value) return
  if (!places.value || places.value.length === 0) return

  weatherLoading.value = true
  try {
    const res = await getPlanLiveWeathers(selectedPlanId.value)
    weathers.value = res.weathers || {}
    weatherErrors.value = res.errors || {}
  } catch (e) {
    weatherError.value = e?.message || '加载天气失败'
  } finally {
    weatherLoading.value = false
  }
}

async function fetchPickWeather(adcode) {
  pickWeatherLoading.value = true
  pickWeatherError.value = ''
  pickWeather.value = null
  try {
    const res = await getLiveWeatherByAdcode(adcode)
    pickWeather.value = res.weather || null
  } catch (e) {
    pickWeatherError.value = e?.message || '选点天气获取失败'
  } finally {
    pickWeatherLoading.value = false
  }
}

function pickWeatherText() {
  if (pickWeatherLoading.value) return '天气加载中…'
  if (pickWeatherError.value) return `天气不可用（${pickWeatherError.value}）`
  if (!pickWeather.value) return '—'
  const w = pickWeather.value
  const t = w.temperature != null ? `${w.temperature}°C` : '—'
  const s = w.status || '—'
  const hum = w.humidity != null ? `${w.humidity}%` : '—'
  const wind =
    w.wind_direction && w.wind_power ? `${w.wind_direction} ${w.wind_power}` : '—'
  return `${s} · ${t} · 湿度 ${hum} · 风 ${wind}`
}

function weatherText(placeId) {
  const w = weathers.value?.[placeId]
  if (w) {
    const t = w.temperature != null ? `${w.temperature}°C` : '—'
    const s = w.status || '—'
    return `${s} · ${t}`
  }
  const err = weatherErrors.value?.[placeId]
  if (err) return `天气不可用（${err}）`
  if (weatherLoading.value) return '天气加载中…'
  return '—'
}

const canAddPlace = computed(() => Boolean(selectedPlanId.value && selectedPlace.value && selectedPlace.value.address && selectedPlace.value.address !== '解析中…'))

async function addSelectedPlace() {
  if (!canAddPlace.value) return
  addingPlace.value = true
  placesError.value = ''
  try {
    const payload = {
      name: selectedPlace.value.name || '选中地点',
      address: selectedPlace.value.address || null,
      lng: selectedPlace.value.lng,
      lat: selectedPlace.value.lat,
      adcode: selectedPlace.value.adcode || null,
    }
    await addPlace(selectedPlanId.value, payload)
    await refreshPlaces()
    await refreshChecks()
  } catch (e) {
    placesError.value = e?.message || '加入地点失败'
  } finally {
    addingPlace.value = false
  }
}

async function removePlace(placeId) {
  if (!selectedPlanId.value) return
  placesError.value = ''
  try {
    await deletePlace(selectedPlanId.value, placeId)
    await refreshPlaces()
    await refreshChecks()
  } catch (e) {
    placesError.value = e?.message || '删除失败'
  }
}

onMounted(async () => {
  resetForm()
  await refreshPlans()

  const lastId = localStorage.getItem(LAST_OPEN_PLAN_ID_KEY)
  if (lastId) {
    await openPlan(lastId)
  }

  initAmap()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="title">智能出行规划器</div>
        <div class="subtitle">出行规划</div>
      </div>
      <div class="top-actions">
        <button class="btn" type="button" @click="newPlan">新建</button>
        <button class="btn primary" type="button" :disabled="saving || planLoading" @click="savePlan">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="btn" type="button" :disabled="!selectedPlanId" @click="runExport('md')">导出 MD</button>
        <button class="btn" type="button" :disabled="!selectedPlanId" @click="runExport('json')">导出 JSON</button>
      </div>
    </header>

    <main class="main">
      <aside class="sidebar">
        <div class="panel-title">我的规划</div>

        <div v-if="listLoading" class="state">加载中…</div>
        <div v-else-if="listError" class="state error">
          <div>加载失败：{{ listError }}</div>
          <button class="btn small" type="button" @click="refreshPlans">重试</button>
        </div>
        <div v-else-if="emptyList" class="state">暂无规划</div>

        <ul v-else class="plan-list">
          <li v-for="p in plans" :key="p.id">
            <button
              class="plan-item"
              type="button"
              :aria-current="p.id === selectedPlanId ? 'true' : 'false'"
              :data-active="p.id === selectedPlanId ? 'true' : 'false'"
              @click="openPlan(p.id)"
            >
              <div class="plan-name">
                {{ p.title || '未命名规划' }}
              </div>
              <div class="plan-meta">
                <span>{{ p.date }}</span>
                <span v-if="p.budget != null">¥{{ p.budget }}</span>
                <span v-if="p.people_count != null">{{ p.people_count }} 人</span>
              </div>
            </button>
          </li>
        </ul>
      </aside>

      <section class="content">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">
                {{ isEditingExisting ? '编辑规划' : '新建规划' }}
              </div>
              <div class="card-subtitle">{{ nextStepText }}</div>
            </div>

            <div class="badge" v-if="selectedPlanId">
              已打开：{{ selectedPlanId.slice(0, 8) }}
            </div>
          </div>

          <div v-if="planLoading" class="state">加载中…</div>
          <div v-else-if="planError" class="state error">
            <div>加载失败：{{ planError }}</div>
            <button v-if="selectedPlanId" class="btn small" type="button" @click="openPlan(selectedPlanId)">
              重试
            </button>
          </div>

          <form v-else class="form" @submit.prevent="savePlan">
            <div class="grid">
              <label class="field">
                <span class="label">日期</span>
                <input class="input" type="date" v-model="form.date" required />
              </label>

              <label class="field">
                <span class="label">预算（元）</span>
                <input class="input" type="number" min="0" step="1" inputmode="numeric" v-model="form.budget" />
              </label>

              <label class="field">
                <span class="label">人数</span>
                <input class="input" type="number" min="1" step="1" inputmode="numeric" v-model="form.people_count" />
              </label>

              <label class="field">
                <span class="label">标题</span>
                <input class="input" type="text" maxlength="120" v-model="form.title" placeholder="周末出游" />
              </label>
            </div>

            <label class="field">
              <span class="label">偏好</span>
              <textarea class="textarea" rows="4" maxlength="2000" v-model="form.preferences" placeholder="自然景点 / 少走路 / 小吃…"></textarea>
            </label>

            <div class="form-actions">
              <button class="btn primary" type="submit" :disabled="saving">
                {{ saving ? '保存中…' : '保存' }}
              </button>
              <button class="btn" type="button" :disabled="saving || planLoading" @click="refreshPlans">
                刷新列表
              </button>
            </div>

            <div v-if="saveSuccess" class="notice success">
              已保存
            </div>
            <div v-else-if="saveError" class="notice error">
              保存失败：{{ saveError }}
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">地点</div>
              <div class="card-subtitle">选点后加入</div>
            </div>
            <div class="badge" v-if="selectedPlanId">
              当前规划：{{ selectedPlanId.slice(0, 8) }}
            </div>
          </div>

          <div v-if="mapError" class="notice error">
            {{ mapError }}
          </div>

          <div v-else class="map-wrap">
            <div id="amap" class="map" :data-ready="amapReady ? 'true' : 'false'"></div>
            <div class="map-side">
              <div class="panel-title">选点</div>
              <div v-if="!selectedPlace" class="state">
                点击地图
              </div>
              <div v-else class="pick">
                <div class="pick-row">
                  <div class="k">经纬度</div>
                  <div class="v mono">
                    {{ selectedPlace.lng.toFixed(6) }}, {{ selectedPlace.lat.toFixed(6) }}
                  </div>
                </div>
                <div class="pick-row">
                  <div class="k">地址</div>
                  <div class="v">{{ selectedPlace.address }}</div>
                </div>
                <div class="pick-row" v-if="selectedPlace.adcode">
                  <div class="k">adcode</div>
                  <div class="v mono">{{ selectedPlace.adcode }}</div>
                </div>
                <div class="pick-row">
                  <div class="k">实时天气</div>
                  <div class="v">
                    <span class="chip">{{ pickWeatherText() }}</span>
                  </div>
                </div>
                <button class="btn primary" type="button" :disabled="!canAddPlace || addingPlace" @click="addSelectedPlace">
                  {{ addingPlace ? '加入中…' : selectedPlanId ? '加入' : '先保存规划' }}
                </button>
              </div>

              <div class="panel-title" style="margin-top: 16px">列表</div>
              <div v-if="!selectedPlanId" class="state">
                先保存规划
              </div>
              <div v-else-if="placesLoading" class="state">加载中…</div>
              <div v-else-if="placesError" class="state error">
                <div>加载失败：{{ placesError }}</div>
                <button class="btn small" type="button" @click="refreshPlaces">重试</button>
              </div>
              <div v-else-if="places.length === 0" class="state">
                暂无地点
              </div>
              <div v-else-if="weatherError" class="notice error" style="margin-bottom: 10px">
                天气加载失败：{{ weatherError }}
                <button class="btn small" type="button" style="margin-left: 8px" @click="refreshWeathers">重试</button>
              </div>
              <ul v-else class="place-list">
                <li v-for="pl in places" :key="pl.id" class="place-item">
                  <div class="place-main">
                    <div class="place-name">{{ pl.name || '地点' }}</div>
                    <div class="place-sub">
                      <span class="mono">{{ Number(pl.lng).toFixed(4) }}, {{ Number(pl.lat).toFixed(4) }}</span>
                      <span v-if="pl.adcode" class="mono">adcode {{ pl.adcode }}</span>
                      <span class="chip">{{ weatherText(pl.id) }}</span>
                    </div>
                    <div class="place-addr" v-if="pl.address">{{ pl.address }}</div>
                  </div>
                  <button class="btn small" type="button" @click="removePlace(pl.id)">删除</button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">行程安排</div>
              <div class="card-subtitle">把地点分配到上午 / 下午 / 晚上</div>
            </div>
          </div>

          <div v-if="!selectedPlanId" class="state">先保存一个规划再安排时间段。</div>
          <div v-else-if="itineraryLoading" class="state">加载中…</div>
          <div v-else-if="itineraryError" class="notice error">
            行程加载失败：{{ itineraryError }}
            <button class="btn small" type="button" style="margin-left: 8px" @click="refreshItinerary">重试</button>
          </div>
          <div v-else class="itinerary">
            <div class="itinerary-left">
              <div class="panel-title">给地点选择时间段</div>
              <div v-if="places.length === 0" class="state">还没有地点。先在地图选点并加入规划。</div>
              <div v-else class="slot-list">
                <div v-for="pl in places" :key="pl.id" class="slot-row">
                  <div class="slot-main">
                    <div class="place-name">{{ pl.name || '地点' }}</div>
                    <div class="place-sub">
                      <span class="mono">{{ Number(pl.lng).toFixed(4) }}, {{ Number(pl.lat).toFixed(4) }}</span>
                      <span class="chip">{{ weatherText(pl.id) }}</span>
                    </div>
                  </div>
                  <select class="select" :value="getSlot(pl.id)" @change="setSlot(pl.id, $event.target.value)">
                    <option v-for="o in timeSlotOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                </div>
              </div>

              <div class="form-actions">
                <button class="btn primary" type="button" :disabled="savingItinerary || !selectedPlanId" @click="saveSlots">
                  {{ savingItinerary ? '保存中…' : '保存安排' }}
                </button>
              </div>
            </div>

            <div class="itinerary-right">
              <div class="panel-title">当前安排预览</div>
              <div class="preview">
                <div class="preview-col">
                  <div class="preview-title">上午</div>
                  <div v-if="placesInSlot('morning').length === 0" class="muted">未安排</div>
                  <ul v-else class="mini-list">
                    <li v-for="p in placesInSlot('morning')" :key="p.id">{{ p.name || '地点' }}</li>
                  </ul>
                </div>
                <div class="preview-col">
                  <div class="preview-title">下午</div>
                  <div v-if="placesInSlot('afternoon').length === 0" class="muted">未安排</div>
                  <ul v-else class="mini-list">
                    <li v-for="p in placesInSlot('afternoon')" :key="p.id">{{ p.name || '地点' }}</li>
                  </ul>
                </div>
                <div class="preview-col">
                  <div class="preview-title">晚上</div>
                  <div v-if="placesInSlot('evening').length === 0" class="muted">未安排</div>
                  <ul v-else class="mini-list">
                    <li v-for="p in placesInSlot('evening')" :key="p.id">{{ p.name || '地点' }}</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">AI 总结</div>
              <div class="card-subtitle">基于当前规划自动生成建议</div>
            </div>
          </div>

          <div v-if="!selectedPlanId" class="state">先保存一个规划并加入地点。</div>
          <div v-else class="ai-box">
            <div class="form-actions">
              <button class="btn primary" type="button" :disabled="aiLoading" @click="runAiSummary">
                {{ aiLoading ? '生成中…' : '生成' }}
              </button>
              <button class="btn" type="button" :disabled="checksLoading" @click="refreshChecks">
                {{ checksLoading ? '检查中…' : '规则检查' }}
              </button>
            </div>
            <div v-if="aiError" class="notice error">生成失败：{{ aiError }}</div>
            <div v-else-if="aiSummary" class="ai-result">{{ aiSummary }}</div>
            <div v-else class="muted">—</div>

            <div v-if="checksError" class="notice error" style="margin-top: 10px">
              检查失败：{{ checksError }}
            </div>
            <div v-else-if="checks.length" class="checks" style="margin-top: 10px">
              <div v-for="c in checks" :key="c.code" class="check" :data-level="c.level">
                <div class="check-title">{{ c.title }}</div>
                <div v-if="c.detail" class="check-detail">{{ c.detail }}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  background: radial-gradient(1200px 700px at 15% 0%, rgba(170, 59, 255, 0.10), transparent 55%),
    radial-gradient(900px 650px at 85% 10%, rgba(34, 197, 94, 0.08), transparent 55%);
}

.app-shell {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(10px);
}

.brand .title {
  font-family: var(--heading);
  color: var(--text-h);
  font-size: 17px;
  letter-spacing: -0.2px;
}
.brand .subtitle {
  margin-top: 2px;
  font-size: 13px;
  color: var(--text);
}

.top-actions {
  display: flex;
  gap: 10px;
}

.main {
  width: 1126px;
  max-width: 100%;
  margin: 0 auto;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: 320px 1fr;
  border-inline: 1px solid var(--border);
  box-sizing: border-box;
}

.sidebar {
  border-right: 1px solid var(--border);
  padding: 16px;
  text-align: left;
}

.content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel-title {
  font-family: var(--heading);
  color: var(--text-h);
  font-size: 14px;
  letter-spacing: 0.2px;
  margin-bottom: 12px;
}

.plan-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.plan-item {
  width: 100%;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s;
}

.plan-item[data-active='true'] {
  border-color: var(--accent-border);
  box-shadow: var(--shadow);
}

.plan-name {
  color: var(--text-h);
  font-weight: 500;
  margin-bottom: 6px;
}

.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
}

.card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  text-align: left;
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  box-shadow: var(--shadow);
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 12px;
}

.card-title {
  font-family: var(--heading);
  color: var(--text-h);
  font-size: 18px;
  margin-bottom: 4px;
}
.card-subtitle {
  font-size: 13px;
  color: var(--text);
}

.badge {
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--social-bg);
  color: var(--text-h);
  white-space: nowrap;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 12px;
  color: var(--text);
}

.input,
.textarea {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
  color: var(--text-h);
  background: transparent;
}

.textarea {
  resize: vertical;
  min-height: 110px;
}

.btn {
  border-radius: 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-h);
  padding: 10px 12px;
  cursor: pointer;
  transition: box-shadow 0.2s, border-color 0.2s, background 0.2s;
}

.btn:hover {
  box-shadow: var(--shadow);
}

.btn:focus-visible,
.input:focus-visible,
.textarea:focus-visible,
.select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn.primary {
  border-color: var(--accent-border);
  background: var(--accent-bg);
  color: var(--accent);
}

.btn.small {
  padding: 8px 10px;
  font-size: 13px;
}

.state {
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 12px;
  color: var(--text);
}

.state,
.notice {
  backdrop-filter: blur(6px);
}

.state.error {
  border-style: solid;
  border-color: color-mix(in srgb, #ef4444 45%, var(--border));
}

.notice {
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
}

.notice.success {
  border: 1px solid color-mix(in srgb, #22c55e 35%, var(--border));
  background: color-mix(in srgb, #22c55e 10%, transparent);
  color: var(--text-h);
}

.notice.error {
  border: 1px solid color-mix(in srgb, #ef4444 35%, var(--border));
  background: color-mix(in srgb, #ef4444 10%, transparent);
  color: var(--text-h);
}

.form-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-start;
}

.muted {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text);
}

.map-wrap {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 14px;
}

.map {
  height: 380px;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--social-bg);
  box-shadow: var(--shadow);
}

.map-side {
  text-align: left;
}

.pick {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pick-row .k {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 2px;
}
.pick-row .v {
  color: var(--text-h);
  font-size: 13px;
  line-height: 1.35;
}

.mono {
  font-family: var(--mono);
}

.place-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.place-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  justify-content: space-between;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
}

.place-main {
  min-width: 0;
}

.place-name {
  color: var(--text-h);
  font-weight: 500;
  margin-bottom: 4px;
}

.place-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
  margin-bottom: 6px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent-bg) 65%, transparent);
  color: var(--text-h);
}

.itinerary {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 14px;
}

.slot-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.slot-row {
  display: grid;
  grid-template-columns: 1fr 140px;
  gap: 10px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
}

.select {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  font: inherit;
  color: var(--text-h);
  background: transparent;
}

.preview {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 12px;
}

.preview-col {
  border: 1px dashed var(--border);
  border-radius: 12px;
  padding: 10px 12px;
}

.preview-title {
  font-family: var(--heading);
  color: var(--text-h);
  font-size: 14px;
  margin-bottom: 6px;
}

.mini-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-h);
  font-size: 13px;
}

.ai-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-result {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-h);
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 12px;
}

.check[data-level='warn'] {
  border-color: color-mix(in srgb, #f59e0b 45%, var(--border));
  background: color-mix(in srgb, #f59e0b 10%, transparent);
}

.check-title {
  font-size: 13px;
  color: var(--text-h);
  font-weight: 500;
}

.check-detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text);
}

.place-addr {
  font-size: 12px;
  color: var(--text);
}

@media (max-width: 980px) {
  .main {
    grid-template-columns: 1fr;
  }
  .sidebar {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .map-wrap {
    grid-template-columns: 1fr;
  }
  .itinerary {
    grid-template-columns: 1fr;
  }
  .slot-row {
    grid-template-columns: 1fr;
  }
}
</style>

