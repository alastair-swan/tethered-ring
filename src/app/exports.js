// File exports: engineering specs (CSV) and Google Earth paths (KML).

export function downloadText(text, fileName, mimeType = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// CSV with three sections: GUI parameters, derived design parameters, derived specifications.
export function specsCsv(definitions, derived, specs) {
  const lines = ['// GUI Parameters']
  for (const [k, v] of Object.entries(definitions)) lines.push(`${k},${v.value},${v.units ?? ''}`)
  lines.push('// Design Parameters')
  for (const [k, v] of Object.entries(derived)) {
    if (!(k in definitions) || definitions[k].autoMap === false) lines.push(`${k},${v.value},${v.units ?? ''}`)
  }
  lines.push('// Derived Specifications')
  for (const [k, v] of Object.entries(specs)) lines.push(`${k},${v.value},${v.units ?? ''}`)
  return lines.join('\n') + '\n'
}
