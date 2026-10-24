import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 24 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const HF_SPACE_URL = 'https://yisol-idm-vton.hf.space'

function json(res, statusCode, body) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Sorğu ölçüsü çox böyükdür.'), { statusCode: 413 }))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('Sorğu məlumatları oxunmadı.'), { statusCode: 400 })) }
    })
    req.on('error', reject)
  })
}

function validateImage(data, mimeType, label) {
  if (typeof data !== 'string' || !ALLOWED_IMAGE_TYPES.has(mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw Object.assign(new Error(`${label} üçün JPG, PNG və ya WEBP şəkli tələb olunur.`), { statusCode: 400 })
  }
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error(`${label} ölçüsü 8 MB-dan çox olmamalıdır.`), { statusCode: 413 })
  }
  return data
}

function tryOnApi(hfToken) {
  return {
    name: 'provaai-huggingface-try-on-api',
    configureServer(server) {
      server.middlewares.use('/api/try-on', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'Yalnız POST sorğusu qəbul edilir.' })
        if (!hfToken) return json(res, 503, { error: 'Hugging Face tokeni tapılmadı. .env.local faylında HF_TOKEN dəyişənini yoxlayın və serveri yenidən başladın.' })

        try {
          const input = await readJson(req)
          const personImage = validateImage(input.personImage, input.personMimeType, 'Şəxsi şəkil')
          const garmentImage = validateImage(input.garmentImage, input.garmentMimeType, 'Geyim şəkli')
          const auth = { Authorization: `Bearer ${hfToken}` }

          const upload = async (data, mimeType, name) => {
            const form = new FormData()
            const bytes = Buffer.from(data, 'base64')
            const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg'
            form.append('files', new Blob([bytes], { type: mimeType }), `${name}${extension}`)
            // This Space currently runs the legacy Gradio REST API (`/upload` + `/run/...`),
            // not the newer `/gradio_api/*` routes.
            const response = await fetch(`${HF_SPACE_URL}/upload`, {
              method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(60000)
            })
            if (!response.ok) {
              const error = response.status === 401 || response.status === 403
                ? 'Hugging Face tokeni qəbul edilmədi. Read icazəli tokeni yoxlayın.'
                : 'Şəkilləri Hugging Face demo xidmətinə yükləmək mümkün olmadı.'
              throw Object.assign(new Error(error), { statusCode: response.status })
            }
            const paths = await response.json()
            if (!Array.isArray(paths) || typeof paths[0] !== 'string') throw new Error('Hugging Face şəkil yükləmə cavabı düzgün deyil.')
            return {
              path: paths[0],
              url: `${HF_SPACE_URL}/file=${paths[0]}`,
              orig_name: `${name}${extension}`,
              size: bytes.length,
              mime_type: mimeType,
              meta: { _type: 'gradio.FileData' }
            }
          }

          const [personFile, garmentFile] = await Promise.all([
            upload(personImage, input.personMimeType, 'person-photo'),
            upload(garmentImage, input.garmentMimeType, 'garment-reference')
          ])
          const sessionHash = crypto.randomUUID().replaceAll('-', '')
          const submitted = await fetch(`${HF_SPACE_URL}/queue/join`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn_index: 2, session_hash: sessionHash, data: [
              { background: personFile, layers: [], composite: null },
              garmentFile,
              typeof input.garmentDescription === 'string' ? input.garmentDescription.slice(0, 160) : 'red midi dress',
              true,
              false,
              30,
              42
            ] }),
            signal: AbortSignal.timeout(60000)
          })
          if (!submitted.ok) {
            const message = submitted.status === 429
              ? 'Hugging Face pulsuz sınaq limiti dolub. Limit yenilənəndə yenidən yoxlayın.'
              : 'Hugging Face virtual prova sorğusunu qəbul etmədi.'
            return json(res, submitted.status === 429 ? 429 : 502, { error: message })
          }
          const queued = await submitted.json()
          const resultResponse = await fetch(`${HF_SPACE_URL}/queue/data?session_hash=${encodeURIComponent(sessionHash)}`, {
            headers: { ...auth, Accept: 'text/event-stream' },
            signal: AbortSignal.timeout(300000)
          })
          if (!resultResponse.ok) return json(res, resultResponse.status === 429 ? 429 : 502, { error: 'Hugging Face növbəsindən nəticəni almaq mümkün olmadı.' })
          const eventStream = await resultResponse.text()
          const events = eventStream.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => { try { return JSON.parse(line.slice(5).trim()) } catch { return null } }).filter(Boolean)
          const finalEvent = events.find(event => event.msg === 'process_completed' && event.output)
          const generated = finalEvent?.output?.data?.[0]
          if (!generated && events.some(event => event.msg === 'process_completed' && event.success === false)) {
            throw new Error('Hugging Face virtual prova modelində xəta baş verdi. Başqa şəkillərlə yenidən yoxlayın.')
          }
          if (!generated) throw new Error('Hugging Face bu dəfə şəkil nəticəsi qaytarmadı. Şəkilləri dəyişib yenidən sınayın.')

          let imageUrl = typeof generated === 'string'
            ? (generated.startsWith('data:image/') || /^https?:\/\//i.test(generated) ? generated : `${HF_SPACE_URL}/file=${generated}`)
            : generated.url
          const resultPath = typeof generated === 'object' ? generated.name || generated.path : null
          if (!imageUrl && resultPath) imageUrl = `${HF_SPACE_URL}/file=${resultPath}`
          if (!imageUrl) throw new Error('Hugging Face cavabında nəticə şəkli tapılmadı.')
          if (imageUrl.startsWith('data:image/')) {
            const match = imageUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
            if (!match) throw new Error('Şəkil nəticəsinin formatı oxunmadı.')
            return json(res, 200, { image: match[2], mimeType: match[1] })
          }
          const imageResponse = await fetch(imageUrl, { signal: AbortSignal.timeout(60000) })
          if (!imageResponse.ok) throw new Error('Hazır try-on şəklini yükləmək mümkün olmadı.')
          const imageBytes = Buffer.from(await imageResponse.arrayBuffer())
          if (!imageBytes.length || imageBytes.length > MAX_IMAGE_BYTES * 2) throw new Error('Nəticə şəklinin ölçüsü gözləniləndən böyükdür.')
          return json(res, 200, { image: imageBytes.toString('base64'), mimeType: imageResponse.headers.get('content-type') || 'image/png' })
        } catch (error) {
          if (error.name === 'TimeoutError' || error.name === 'AbortError') return json(res, 504, { error: 'Hugging Face demo sorğusu çox gözlədi. Space növbədə ola bilər; bir az sonra yenidən yoxlayın.' })
          const statusCode = error.statusCode === 401 || error.statusCode === 403 ? 401 : error.statusCode || 502
          return json(res, statusCode, { error: error.message || 'Sorğu tamamlanmadı. Hugging Face Space statusunu yoxlayın.' })
        }
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), tryOnApi(process.env.HF_TOKEN || env.HF_TOKEN)]
  }
})
