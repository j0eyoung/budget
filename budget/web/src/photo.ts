// Shrinks a phone photo before upload: long edge 1600px, JPEG. Keeps the
// request small for the HA Green and is plenty for reading receipt text.
export async function photoToJpeg(file: File, maxEdge = 1600): Promise<{ data: string; mediaType: string }> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' }
  } catch {
    throw new Error("Couldn't open that photo. Try a JPEG or PNG.")
  } finally {
    URL.revokeObjectURL(url)
  }
}
