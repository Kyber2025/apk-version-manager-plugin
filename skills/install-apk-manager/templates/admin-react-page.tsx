/**
 * ApksAdminPage — React admin UI for the apk-version-manager pattern.
 *
 * Optional. Pairs with the backend route module's manifest + upload + delete
 * endpoints. Shows version list, lets admin upload new APK, shows QR code
 * for download URL, marks latest version.
 *
 * Integration:
 *   1. Drop this file in your admin pages dir.
 *   2. Add a route entry for it.
 *   3. Customize the imports (Card / Button / Input / toast / auth client) to
 *      match your design system.
 *   4. Set API_BASE if your client doesn't already pin to backend root.
 */
import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

// ── CUSTOMIZE: replace with your own UI component imports + axios client ───
// import { Card, CardHeader, CardContent } from '../../components/ui/Card'
// import { Button } from '../../components/ui/Button'
// import { Input } from '../../components/ui/Input'
// import toast from 'react-hot-toast'
// import client from '../../api/client'

// Minimal placeholders so this file parses standalone. Delete + use yours.
const Card: any = ({ children }: any) => <div>{children}</div>
const CardHeader: any = ({ children }: any) => <div>{children}</div>
const CardContent: any = ({ children }: any) => <div>{children}</div>
const Button: any = ({ children, ...p }: any) => <button {...p}>{children}</button>
const Input: any = (p: any) => <input {...p} />
const toast = { success: (m: string) => alert(m), error: (m: string) => alert('Error: ' + m) }
const client = { get: async (u: string) => ({ data: await fetch(u).then((r) => r.json()) }) }
// ──────────────────────────────────────────────────────────────────────────────

interface ApkInfo {
  filename: string
  package: string
  version: string
  sizeBytes: number
  sha256: string
  uploadedAt: string
  downloadUrl: string
}

export function ApksAdminPage() {
  const qc = useQueryClient()
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['apks-manifest'],
    queryFn: async () => {
      const { data } = await client.get('/apks/manifest')
      return data as { apks: ApkInfo[]; latest: ApkInfo | null }
    },
  })

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append('file', file, file.name)
      const r = await fetch('/apks/upload', {
        method: 'POST',
        body: fd,
        // Add your auth header here:
        // headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
      })
      if (!r.ok) throw new Error((await r.json()).error || 'upload failed')
      return r.json()
    },
    onSuccess: () => {
      toast.success('APK uploaded')
      setUploadFile(null)
      qc.invalidateQueries({ queryKey: ['apks-manifest'] })
    },
    onError: (err: any) => toast.error(String(err.message || err)),
  })

  const deleteMut = useMutation({
    mutationFn: async (filename: string) => {
      const r = await fetch(`/apks/${filename}`, { method: 'DELETE' })
      if (!r.ok) throw new Error('delete failed')
      return r.json()
    },
    onSuccess: () => {
      toast.success('APK deleted')
      qc.invalidateQueries({ queryKey: ['apks-manifest'] })
    },
  })

  const fmtSize = (b: number) => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`)

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
      <h1>APK Version Manager</h1>
      <p style={{ color: '#888' }}>
        Filename convention: <code>{'<package>-v<version>.apk'}</code> (e.g. <code>myapp-v1.2.3.apk</code>)
      </p>

      <Card>
        <CardHeader>
          <h2>Upload new APK</h2>
        </CardHeader>
        <CardContent>
          <Input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={(e: any) => setUploadFile(e.target.files?.[0] ?? null)}
          />
          <Button
            disabled={!uploadFile || uploadMut.isPending}
            onClick={() => uploadFile && uploadMut.mutate(uploadFile)}
          >
            {uploadMut.isPending ? 'Uploading...' : 'Upload'}
          </Button>
          {uploadFile && (
            <p style={{ fontSize: 12, color: '#888' }}>
              {uploadFile.name} · {fmtSize(uploadFile.size)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card style={{ marginTop: 16 }}>
        <CardHeader>
          <h2>Available versions ({data?.apks.length ?? 0})</h2>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p>Loading...</p>
          ) : !data?.apks.length ? (
            <p style={{ color: '#888' }}>No APKs uploaded yet.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Version</th>
                  <th align="left">Package</th>
                  <th align="left">Size</th>
                  <th align="left">SHA256</th>
                  <th align="left">Uploaded</th>
                  <th align="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.apks.map((a) => (
                  <tr key={a.filename}>
                    <td>
                      v{a.version}
                      {data.latest?.filename === a.filename && <span style={{ color: 'green', marginLeft: 8 }}>● Latest</span>}
                    </td>
                    <td>{a.package}</td>
                    <td>{fmtSize(a.sizeBytes)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{a.sha256.slice(0, 12)}...</td>
                    <td>{new Date(a.uploadedAt).toLocaleString()}</td>
                    <td align="right">
                      <a href={a.downloadUrl} target="_blank" rel="noreferrer">Download</a>{' '}
                      <a href={`/apks/qr/${a.filename}`} target="_blank" rel="noreferrer">QR</a>{' '}
                      <button onClick={() => confirm(`Delete ${a.filename}?`) && deleteMut.mutate(a.filename)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
