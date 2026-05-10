<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
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

/** 窄屏侧栏抽屉：规划列表从左侧滑出，避免小屏上长列表顶在内容前 */
const planDrawerOpen = ref(false)

function closePlanDrawer() {
  planDrawerOpen.value = false
}

function togglePlanDrawer() {
  planDrawerOpen.value = !planDrawerOpen.value
}

let mqDrawer = null
function syncDrawerFromMq() {
  if (typeof window === 'undefined' || !window.matchMedia) return
  if (!mqDrawer) {
    mqDrawer = window.matchMedia('(min-width: 769px)')
  }
  if (mqDrawer.matches) planDrawerOpen.value = false
}

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

/**
 * @param {Record<string, unknown> | null} [justSaved] 刚保存/创建返回的一行；列表接口偶发空读时用来保住侧栏，避免「已保存但暂无规划」。
 */
async function refreshPlans(justSaved = null) {
  listLoading.value = true
  listError.value = ''
  try {
    const rows = await listPlans()
    if (justSaved && justSaved.id) {
      const others = rows.filter((p) => p.id !== justSaved.id)
      plans.value = [justSaved, ...others]
    } else {
      plans.value = rows
    }
  } catch (e) {
    listError.value = e?.message || '加载规划列表失败'
    if (justSaved && justSaved.id) {
      plans.value = [justSaved]
    } else {
      plans.value = []
    }
  } finally {
    listLoading.value = false
  }
}

async function openPlan(planId) {
  closePlanDrawer()
  selectedPlanId.value = planId
  localStorage.setItem(LAST_OPEN_PLAN_ID_KEY, planId)

  planLoading.value = true
  planError.value = ''
  saveError.value = ''
  saveSuccess.value = false
  try {
    let p
    const maxTry = 5
    for (let t = 0; t < maxTry; t++) {
      try {
        p = await getPlan(planId)
        break
      } catch (e) {
        const is404 = e?.status === 404 || /not found/i.test(e?.message || '')
        if (!is404 || t === maxTry - 1) throw e
        await new Promise((r) => setTimeout(r, 400 + t * 150))
      }
    }
    form.title = p.title || ''
    form.date = p.date || todayISO()
    form.budget = p.budget ?? ''
    form.people_count = p.people_count ?? ''
    form.preferences = p.preferences || ''
  } catch (e) {
    const msg = e?.message || '加载规划失败'
    if (e?.status === 404 || /not found/i.test(msg)) {
      const cached = (plans.value || []).find((p) => p.id === planId)
      if (cached) {
        form.title = cached.title || ''
        form.date = cached.date || todayISO()
        form.budget = cached.budget ?? ''
        form.people_count = cached.people_count ?? ''
        form.preferences = cached.preferences || ''
        planError.value =
          '云端详情暂未同步（常见于刚保存后）。已用侧栏列表中的数据填充表单，可稍候再点「重试」或刷新列表。'
      } else {
        localStorage.removeItem(LAST_OPEN_PLAN_ID_KEY)
        selectedPlanId.value = null
        planError.value =
          '该规划不存在或已失效（例如切换了云端环境、或多实例尚未同步）。请从左侧列表重新选择或新建。'
      }
    } else {
      planError.value = msg
    }
  } finally {
    planLoading.value = false
  }

  await refreshPlaces()
  await refreshItinerary()
  await refreshChecks()
}

function newPlan() {
  closePlanDrawer()
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

    await refreshPlans(saved)
    await refreshPlaces()
    await refreshItinerary()
    await refreshChecks()
    saveSuccess.value = true
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
  if (typeof window !== 'undefined' && window.matchMedia) {
    mqDrawer = window.matchMedia('(min-width: 769px)')
    mqDrawer.addEventListener('change', syncDrawerFromMq)
  }

  resetForm()
  // 地图与规划 API 解耦：云端列表/详情若较慢或挂起，不应阻塞高德初始化
  initAmap()

  await refreshPlans()

  const lastId = localStorage.getItem(LAST_OPEN_PLAN_ID_KEY)
  if (lastId) {
    await openPlan(lastId)
  }
})

onUnmounted(() => {
  if (mqDrawer) mqDrawer.removeEventListener('change', syncDrawerFromMq)
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-left">
        <button
          type="button"
          class="btn nav-toggle"
          aria-label="打开或收起规划列表"
          :aria-expanded="planDrawerOpen ? 'true' : 'false'"
          aria-controls="plan-sidebar"
          @click="togglePlanDrawer"
        >
          规划列表
        </button>
        <div class="brand">
          <div class="title">智能出行规划器</div>
          <div class="subtitle">出行规划 · 多端同步</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="btn" type="button" @click="newPlan">新建</button>
        <button class="btn primary" type="button" :disabled="saving || planLoading" @click="savePlan">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="btn export-btn" type="button" :disabled="!selectedPlanId" @click="runExport('md')">
          <span class="export-lbl-full">导出 MD</span><span class="export-lbl-short">MD</span>
        </button>
        <button class="btn export-btn" type="button" :disabled="!selectedPlanId" @click="runExport('json')">
          <span class="export-lbl-full">导出 JSON</span><span class="export-lbl-short">JSON</span>
        </button>
      </div>
    </header>

    <div
      v-show="planDrawerOpen"
      class="drawer-overlay"
      aria-hidden="true"
      @click="closePlanDrawer"
    />

    <main class="main">
      <aside
        id="plan-sidebar"
        class="sidebar"
        :class="{ 'sidebar--open': planDrawerOpen }"
      >
        <div class="sidebar-head">
          <div class="panel-title">我的规划</div>
          <button type="button" class="btn drawer-close" aria-label="关闭规划列表" @click="closePlanDrawer">×</button>
        </div>

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

      <div class="main-inner">
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
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100svh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background-color: #f8f9fb;
  background-image: url('/decoration-mountains.svg');
  background-repeat: no-repeat;
  background-position: calc(100% + 20px) 12%;
  background-size: min(480px, 46vw) auto;
}

@media (max-width: 768px) {
  .app-shell {
    background-position: 50% -24px;
    background-size: min(104vw, 440px) auto;
  }
}

.topbar {
  --topbar-h: 52px;
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  padding-top: max(12px, env(safe-area-inset-top, 0px));
  min-height: var(--topbar-h);
  border-bottom: 1px solid #ede9f7;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(14px);
  box-shadow: 0 4px 24px -12px rgba(99, 71, 209, 0.12);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.nav-toggle {
  display: none;
  flex-shrink: 0;
  padding: 10px 12px;
  font-size: 14px;
}

.drawer-overlay {
  display: none;
}

.sidebar-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.sidebar-head .panel-title {
  margin-bottom: 8px;
}

.drawer-close {
  display: none;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  padding: 0;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  line-height: 1;
  border-radius: 10px;
}

.export-lbl-short {
  display: none;
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
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
}

.main {
  width: 1126px;
  max-width: 100%;
  margin: 0 auto;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  border-inline: 1px solid #e8e4f0;
  box-sizing: border-box;
}

.main-inner {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sidebar {
  border-right: 1px solid #e8e4f0;
  padding: 16px;
  text-align: left;
  background: linear-gradient(180deg, #faf8ff 0%, #f4f1fc 55%, #f0ecfa 100%);
}

.content {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1 1 auto;
  min-height: 0;
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
  border-radius: var(--radius-lg, 16px);
  border: 1px solid #e8e4f0;
  background: var(--card-surface);
  color: inherit;
  padding: 12px;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.3s ease, border-color 0.3s ease, transform 0.2s ease;
}

.plan-item:hover {
  border-color: color-mix(in srgb, var(--accent) 28%, #e8e4f0);
  box-shadow: var(--shadow-card, 0 4px 20px rgba(0, 0, 0, 0.05));
}

.plan-item[data-active='true'] {
  border-color: var(--accent);
  box-shadow: 0 8px 28px -8px rgba(99, 71, 209, 0.22);
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
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 16px;
  text-align: left;
  background: var(--card-surface);
  box-shadow: var(--shadow-card, 0 4px 20px rgba(0, 0, 0, 0.05));
  transition: box-shadow 0.3s ease;
}

.card:hover {
  box-shadow: 0 10px 30px -10px rgba(99, 71, 209, 0.14);
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0eef7;
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
  border: 1px solid #e8e4f0;
  background: #f0eeff;
  color: var(--accent);
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
  border: 1px solid #e0dce8;
  border-radius: var(--radius-btn, 14px);
  padding: 10px 12px;
  font: inherit;
  color: var(--text-h);
  background: var(--input-surface);
  transition: border-color 0.25s ease, box-shadow 0.25s ease;
}

.input:hover,
.textarea:hover {
  border-color: color-mix(in srgb, var(--accent) 22%, #e0dce8);
}

.input:focus,
.textarea:focus {
  border-color: color-mix(in srgb, var(--accent) 45%, #e0dce8);
  box-shadow: 0 0 0 3px rgba(99, 71, 209, 0.12);
}

.textarea {
  resize: vertical;
  min-height: 110px;
}

.btn {
  border-radius: var(--radius-btn, 14px);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, #e0dce8);
  background: var(--card-surface);
  color: var(--accent);
  padding: 10px 12px;
  cursor: pointer;
  transition: box-shadow 0.3s ease, border-color 0.3s ease, background 0.3s ease, color 0.3s ease,
    transform 0.2s ease;
}

.btn:hover {
  border-color: var(--accent);
  box-shadow: 0 8px 22px -8px rgba(99, 71, 209, 0.25);
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
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  font-weight: 500;
}

.btn.primary:hover {
  filter: brightness(1.06);
  box-shadow: 0 10px 28px -6px rgba(99, 71, 209, 0.45);
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
  height: clamp(240px, 42vh, 420px);
  min-height: 220px;
  border: 1px solid #e8e4f0;
  border-radius: var(--radius-lg, 16px);
  overflow: hidden;
  background: var(--map-placeholder);
  box-shadow: var(--shadow-card, 0 4px 20px rgba(0, 0, 0, 0.05));
}

.map-side {
  text-align: left;
}

.pick {
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: color-mix(in srgb, var(--accent) 4%, var(--card-surface));
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
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 10px 12px;
  background: var(--card-surface);
  box-shadow: 0 2px 12px rgba(99, 71, 209, 0.04);
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
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid #e4dff5;
  background: #f0eeff;
  color: var(--accent);
  font-size: 12px;
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
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 10px 12px;
  background: var(--card-surface);
}

.select {
  border: 1px solid #e0dce8;
  border-radius: var(--radius-btn, 14px);
  padding: 10px 12px;
  font: inherit;
  color: var(--text-h);
  background: var(--input-surface);
}

.preview {
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 12px;
  display: grid;
  gap: 12px;
  background: color-mix(in srgb, var(--accent) 5%, var(--card-surface));
}

.preview-col {
  border: 1px dashed #dcd6ee;
  border-radius: 12px;
  padding: 10px 12px;
  background: var(--card-surface);
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
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 12px;
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-h);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--accent) 8%, var(--card-surface)) 0%,
    var(--card-surface) 40%
  );
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.check {
  border: 1px solid #f0eef7;
  border-radius: var(--radius-lg, 16px);
  padding: 10px 12px;
  background: var(--card-surface);
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

@media (prefers-color-scheme: dark) {
  .app-shell {
    background-color: var(--bg);
    background-image: url('/decoration-mountains.svg');
    background-position: calc(100% + 16px) 14%;
    background-size: min(400px, 44vw) auto;
  }

  .topbar {
    background: color-mix(in srgb, var(--card-surface) 94%, transparent);
    border-bottom-color: var(--border);
    box-shadow: 0 4px 28px -14px rgba(0, 0, 0, 0.5);
  }

  .sidebar {
    background: linear-gradient(180deg, #2a243d 0%, #1c1828 100%);
  }

  .card,
  .plan-item,
  .place-item,
  .slot-row,
  .preview-col,
  .check {
    border-color: var(--border);
  }
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

/* 手机：侧栏抽屉 + 触控区域 + 导出按钮短文案 */
@media (max-width: 768px) {
  .nav-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }

  .drawer-overlay {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.38);
    backdrop-filter: blur(3px);
  }

  .main {
    display: block;
    width: 100%;
    max-width: 100%;
    border-inline: none;
  }

  .sidebar {
    position: fixed;
    top: max(var(--topbar-h), env(safe-area-inset-top, 0px));
    left: 0;
    bottom: 0;
    width: min(304px, 88vw);
    max-width: 100%;
    z-index: 45;
    margin: 0;
    padding: 14px 14px calc(16px + env(safe-area-inset-bottom, 0px));
    border-right: 1px solid var(--border);
    border-bottom: none;
    background: var(--card-surface);
    box-shadow: none;
    transform: translateX(-108%);
    transition: transform 0.28s ease;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
  }

  .sidebar.sidebar--open {
    transform: translateX(0);
    box-shadow: 8px 0 28px rgba(0, 0, 0, 0.2);
  }

  .drawer-close {
    display: inline-flex;
  }

  .brand .title {
    font-size: 16px;
  }
  .brand .subtitle {
    font-size: 12px;
  }

  .top-actions {
    width: 100%;
    justify-content: stretch;
  }

  .top-actions .btn {
    flex: 1 1 auto;
    min-width: 0;
    justify-content: center;
    text-align: center;
    min-height: 44px;
    touch-action: manipulation;
  }

  .export-lbl-full {
    display: none;
  }
  .export-lbl-short {
    display: inline;
  }

  .content {
    padding: 12px max(12px, env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px))
      max(12px, env(safe-area-inset-left, 0px));
  }

  .btn,
  .plan-item,
  .select {
    min-height: 44px;
    touch-action: manipulation;
  }

  .btn.small {
    min-height: 40px;
  }

  .map {
    height: min(48vh, 360px);
    min-height: 200px;
  }

  .card {
    padding: 14px;
    border-radius: 14px;
  }

  .form-actions {
    flex-wrap: wrap;
  }

  .form-actions .btn {
    flex: 1 1 calc(50% - 6px);
    min-width: 120px;
  }

  .place-item {
    flex-direction: column;
    align-items: stretch;
  }

  .place-item .btn {
    align-self: flex-end;
  }

  .ai-result {
    font-size: 15px;
    line-height: 1.55;
  }
}

@media (hover: none) and (pointer: coarse) {
  .plan-item:active,
  .btn:active {
    opacity: 0.92;
  }
}
</style>

