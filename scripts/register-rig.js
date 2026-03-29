(() => {
  const form = document.getElementById('rig-registration-form')
  const statusEl = document.getElementById('rig-submit-status')
  const submitButton = document.getElementById('rig-submit-button')

  if (!form || !statusEl || !submitButton) {
    return
  }

  const MAX_IMAGE_DIMENSION = 2560
  const VIDEO_COMPRESS_THRESHOLD_BYTES = 20 * 1024 * 1024

  function setStatus(message, tone) {
    statusEl.textContent = message
    statusEl.className = 'text-sm rounded border px-3 py-2'

    if (tone === 'error') {
      statusEl.classList.add('border-red-400/40', 'bg-red-900/20', 'text-red-200')
    } else if (tone === 'success') {
      statusEl.classList.add('border-green-400/40', 'bg-green-900/20', 'text-green-200')
    } else {
      statusEl.classList.add('border-white/20', 'bg-white/5', 'text-slate-200')
    }

    statusEl.classList.remove('hidden')
  }

  function fileWithExtension(file, ext, type, blob) {
    const base = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.${ext}`, { type, lastModified: Date.now() })
  }

  async function optimizeImageFile(file) {
    const imageBitmap = await createImageBitmap(file)
    let width = imageBitmap.width
    let height = imageBitmap.height

    if (Math.max(width, height) > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / Math.max(width, height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(imageBitmap, 0, 0, width, height)

    const webpBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))

    if (!webpBlob) {
      return file
    }

    if (webpBlob.size < file.size) {
      return fileWithExtension(file, 'webp', 'image/webp', webpBlob)
    }

    return file
  }

  async function optimizeVideoFile(file) {
    if (file.size < VIDEO_COMPRESS_THRESHOLD_BYTES || typeof MediaRecorder === 'undefined') {
      return file
    }

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'

    const objectUrl = URL.createObjectURL(file)

    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('Failed to load video metadata.'))
        video.src = objectUrl
      })

      if (!video.duration || !video.captureStream) {
        return file
      }

      const stream = video.captureStream()
      const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      const mimeType = mimeCandidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))

      if (!mimeType) {
        return file
      }

      const targetBitrate = Math.max(900_000, Math.min(2_500_000, Math.floor((file.size * 8) / video.duration * 0.55)))
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: targetBitrate,
      })

      const chunks = []

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) {
          chunks.push(event.data)
        }
      }

      const stopPromise = new Promise((resolve, reject) => {
        recorder.onstop = resolve
        recorder.onerror = () => reject(new Error('Video compression failed.'))
      })

      recorder.start(500)
      await video.play()

      await new Promise((resolve) => {
        video.onended = resolve
      })

      recorder.stop()
      await stopPromise

      const outputBlob = new Blob(chunks, { type: mimeType })

      if (outputBlob.size > 0 && outputBlob.size < file.size) {
        return fileWithExtension(file, 'webm', 'video/webm', outputBlob)
      }

      return file
    } catch {
      return file
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  async function optimizeFiles(files) {
    const optimized = []

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        optimized.push(await optimizeImageFile(file))
      } else if (file.type.startsWith('video/')) {
        optimized.push(await optimizeVideoFile(file))
      } else {
        optimized.push(file)
      }
    }

    return optimized
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()

    submitButton.disabled = true
    setStatus('Optimizing media and submitting...', 'info')

    try {
      const owner = String(form.owner.value || '').trim()
      const chassisModel = String(form.chassisModel.value || '').trim()
      const battery = String(form.battery.value || '').trim()
      const upgrades = String(form.upgrades.value || '').trim()
      const blog = String(form.blog.value || '').trim()

      if (!owner || !chassisModel || !blog) {
        throw new Error('Owner, Chassis/Model, and Blog are required.')
      }

      const input = document.getElementById('rig-media-input')
      const files = Array.from(input?.files || [])
      const optimizedFiles = await optimizeFiles(files)

      const payload = new FormData()
      payload.set('owner', owner)
      payload.set('chassisModel', chassisModel)
      payload.set('battery', battery)
      payload.set('upgrades', upgrades)
      payload.set('blog', blog)

      optimizedFiles.forEach((file) => {
        payload.append('media', file)
      })

      const response = await fetch('/api/rig-submissions', {
        method: 'POST',
        body: payload,
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Submission failed.')
      }

      form.reset()
      setStatus('Rig submitted successfully and sent for admin/mod approval.', 'success')
    } catch (error) {
      setStatus(error.message || 'Failed to submit rig.', 'error')
    } finally {
      submitButton.disabled = false
    }
  })
})()
