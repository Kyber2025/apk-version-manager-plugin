/**
 * AdminApksPage — React admin UI for the apk-version-manager pattern.
 *
 * This is the production version extracted from KyberRouter
 * (https://ai.applehappy.net/admin/apks). It pairs with the backend route
 * module's /apks/* endpoints and gives admins a self-service UI for:
 *   - Uploading new APKs (drag/click target, client-side filename validation)
 *   - Listing all uploaded APKs, grouped by package, with "Latest" badge
 *   - Showing sha256, size, upload time, full download URL
 *   - Copy URL to clipboard
 *   - Delete with confirmation
 *   - Auto-refresh every 30s
 *
 * ━━━━━━━━━━━━━━━━━━ CUSTOMIZE THESE IMPORTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * This file expects a small UI component library shape. Swap the imports
 * below for your project's equivalents. If you don't have these, see the
 * "Minimal-deps fallbacks" section at the bottom of this file — copy
 * those into a local file and import them instead.
 *
 *   AppLayout       — wrapper providing your app's sidebar/header chrome
 *   Card, CardContent, CardHeader  — panel pattern (most UI kits have this)
 *   Button          — button with variant + disabled + onClick
 *   Modal           — controlled modal with isOpen + onClose + title + children
 *   LoadingSpinner  — spinner component (any size is fine)
 *   useAuthStore    — Zustand store exposing .getState().token (JWT). If you
 *                     use Redux / Context / localStorage directly, swap the
 *                     two getState().token calls below.
 *
 * Also customize these constants if your endpoints differ:
 *   - API base: this template assumes routes are mounted at /apks/* on the
 *     same origin. If your backend is on a different host, change the
 *     `fetch('/apks/...')` calls to absolute URLs.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */
import React, { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Upload, Download, Trash2, Copy, Loader2, Package, CheckCircle2, AlertCircle } from 'lucide-react'
import toast from 'react-hot-toast'

// CUSTOMIZE: swap these for your project's equivalents
import { AppLayout } from '../../components/layout/AppLayout'
import { Card, CardContent, CardHeader } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { LoadingSpinner } from '../../components/ui/LoadingSpinner'
import { useAuthStore } from '../../store/authStore'

interface ApkInfo {
  filename: string
  package: string
  version: string
  sizeBytes: number
  sha256: string
  uploadedAt: string
  downloadUrl: string
}

interface Manifest {
  apks: ApkInfo[]
  latest: ApkInfo | null
}

// Filename regex MUST match the backend's pattern. Client-side validation
// gives the user a clear error before wasting an upload round-trip.
const FILENAME_PATTERN = /^([a-zA-Z0-9_-]+)-v(\d+\.\d+(?:\.\d+)?)\.apk$/

function fmtSize(b: number): string {
  if (b > 1_048_576) return `${(b / 1_048_576).toFixed(2)} MB`
  if (b > 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${b} B`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function AdminApksPage() {
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [filenameError, setFilenameError] = useState<string>('')
  const [deleteModal, setDeleteModal] = useState<ApkInfo | null>(null)

  // Manifest — auto-refresh every 30s so newly uploaded APKs (from scp /
  // curl / a second admin tab) show up without a manual reload
  const { data: manifest, isLoading } = useQuery({
    queryKey: ['apks-manifest'],
    queryFn: async () => {
      const r = await fetch('/apks/manifest')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as Manifest
    },
    refetchInterval: 30_000,
  })

  // Upload — multipart with admin Bearer token
  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      // CUSTOMIZE: how to get the JWT — Zustand here, but Redux/Context/etc all work
      const token = useAuthStore.getState().token
      const fd = new FormData()
      fd.append('file', file, file.name)
      const r = await fetch('/apks/upload', {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Upload failed (HTTP ${r.status})`)
      return body
    },
    onSuccess: () => {
      toast.success('APK uploaded')
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      qc.invalidateQueries({ queryKey: ['apks-manifest'] })
    },
    onError: (err: any) => toast.error(String(err.message || err)),
  })

  const deleteMut = useMutation({
    mutationFn: async (filename: string) => {
      const token = useAuthStore.getState().token
      const r = await fetch(`/apks/${filename}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error || `Delete failed (HTTP ${r.status})`)
      return body
    },
    onSuccess: () => {
      toast.success('APK deleted')
      setDeleteModal(null)
      qc.invalidateQueries({ queryKey: ['apks-manifest'] })
    },
    onError: (err: any) => toast.error(String(err.message || err)),
  })

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setSelectedFile(f)
    if (!f) { setFilenameError(''); return }
    if (!FILENAME_PATTERN.test(f.name)) {
      setFilenameError(
        `Filename must match: <package>-v<version>.apk  ` +
        `e.g. "myapp-v1.2.3.apk". Got: "${f.name}"`
      )
    } else {
      setFilenameError('')
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).then(
      () => toast.success('URL copied'),
      () => toast.error('Copy failed'),
    )
  }

  // Group APKs by package so admin sees all versions of each app at a glance.
  const grouped = (manifest?.apks ?? []).reduce<Record<string, ApkInfo[]>>((acc, apk) => {
    ;(acc[apk.package] ||= []).push(apk)
    return acc
  }, {})

  return (
    <AppLayout>
      <div className="p-6 max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package size={22} /> APK Version Manager
          </h1>
          <p className="text-[#737373] text-sm mt-1">
            Self-hosted APK distribution. Filename convention:{' '}
            <code className="text-brand-300">{'<package>-v<version>.apk'}</code>{' '}
            (e.g. <code className="text-brand-300">myapp-v1.2.3.apk</code>)
          </p>
        </div>

        {/* Upload card */}
        <Card className="mb-6">
          <CardHeader title="Upload new APK" />
          <CardContent>
            <div className="flex flex-col gap-3">
              <label
                htmlFor="apk-upload"
                className={`
                  border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
                  ${selectedFile && !filenameError ? 'border-emerald-500/40 bg-emerald-500/5' : ''}
                  ${filenameError ? 'border-red-500/40 bg-red-500/5' : 'border-[#262626] hover:border-brand-500/40'}
                `}
              >
                <input
                  ref={fileInputRef}
                  id="apk-upload"
                  type="file"
                  accept=".apk,application/vnd.android.package-archive"
                  onChange={onFileChange}
                  className="hidden"
                  disabled={uploadMut.isPending}
                />
                <Upload size={24} className="mx-auto mb-2 text-[#525252]" />
                {selectedFile ? (
                  <div className="text-sm">
                    <p className={`font-medium ${filenameError ? 'text-red-300' : 'text-emerald-300'}`}>
                      {selectedFile.name}
                    </p>
                    <p className="text-xs text-[#737373] mt-1">{fmtSize(selectedFile.size)}</p>
                    {filenameError && (
                      <p className="text-xs text-red-400 mt-2 flex items-center justify-center gap-1">
                        <AlertCircle size={12} /> {filenameError}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[#737373]">Click to pick an APK file</p>
                )}
              </label>

              <Button
                disabled={!selectedFile || !!filenameError || uploadMut.isPending}
                onClick={() => selectedFile && uploadMut.mutate(selectedFile)}
                className="w-full"
              >
                {uploadMut.isPending ? (
                  <><Loader2 size={14} className="animate-spin mr-2" /> Uploading...</>
                ) : (
                  <><Upload size={14} className="mr-2" /> Upload</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Manifest list, grouped by package */}
        {isLoading ? (
          <Card><CardContent><div className="py-8 flex justify-center"><LoadingSpinner /></div></CardContent></Card>
        ) : (manifest?.apks.length ?? 0) === 0 ? (
          <Card>
            <CardContent>
              <div className="py-10 text-center text-[#737373] text-sm">
                No APKs uploaded yet. Use the form above to upload your first version.
              </div>
            </CardContent>
          </Card>
        ) : (
          Object.entries(grouped).map(([pkg, versions]) => (
            <Card key={pkg} className="mb-4">
              <CardHeader
                title={pkg}
                action={
                  <span className="text-xs text-[#737373]">
                    {versions.length} version{versions.length === 1 ? '' : 's'}
                  </span>
                }
              />
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#262626] text-xs text-[#525252] uppercase tracking-wide">
                        <th className="px-4 py-2 text-left">Version</th>
                        <th className="px-4 py-2 text-left">Size</th>
                        <th className="px-4 py-2 text-left">SHA256</th>
                        <th className="px-4 py-2 text-left">Uploaded</th>
                        <th className="px-4 py-2 text-left">Download URL</th>
                        <th className="px-4 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {versions.map((apk) => {
                        const isLatest = manifest?.latest?.filename === apk.filename
                        return (
                          <tr key={apk.filename} className="border-b border-[#1a1a1a] hover:bg-[#161616]">
                            <td className="px-4 py-3">
                              <span className="font-mono text-white font-medium">v{apk.version}</span>
                              {isLatest && (
                                <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                  <CheckCircle2 size={10} /> Latest
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-[#a3a3a3] text-xs">{fmtSize(apk.sizeBytes)}</td>
                            <td className="px-4 py-3 font-mono text-[10px] text-[#737373]" title={apk.sha256}>
                              {apk.sha256.slice(0, 12)}…
                            </td>
                            <td className="px-4 py-3 text-[#737373] text-xs whitespace-nowrap">{fmtDate(apk.uploadedAt)}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1 text-xs">
                                <a
                                  href={apk.downloadUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-brand-300 hover:text-brand-200 truncate max-w-[260px] inline-block"
                                  title={apk.downloadUrl}
                                >
                                  {apk.downloadUrl.replace(/^https?:\/\//, '')}
                                </a>
                                <button
                                  onClick={() => copyUrl(apk.downloadUrl)}
                                  className="text-[#737373] hover:text-white"
                                  title="Copy URL"
                                >
                                  <Copy size={12} />
                                </button>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="inline-flex gap-1">
                                <a
                                  href={apk.downloadUrl}
                                  download
                                  className="inline-flex items-center justify-center w-7 h-7 rounded border border-[#262626] text-[#a3a3a3] hover:bg-[#1a1a1a]"
                                  title="Download"
                                >
                                  <Download size={12} />
                                </a>
                                <button
                                  onClick={() => setDeleteModal(apk)}
                                  className="inline-flex items-center justify-center w-7 h-7 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10"
                                  title="Delete"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {/* How-to footer */}
        <Card>
          <CardHeader title="How devices auto-update" />
          <CardContent>
            <div className="text-xs text-[#737373] space-y-2 leading-relaxed">
              <p>
                Android devices running the app (with ApkUpdater.kt integrated) poll{' '}
                <code className="text-brand-300">/apks/device/version?package=&lt;pkg&gt;&amp;currentVersion=&lt;v&gt;</code>{' '}
                every ~30 minutes. When a newer version is uploaded here, the app prompts the user to install it on its next poll.
              </p>
              <p>
                For manual install on a fresh phone: open the download URL in the phone browser, allow install-from-unknown-sources for the browser, install.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Delete confirm modal */}
        <Modal
          isOpen={!!deleteModal}
          onClose={() => setDeleteModal(null)}
          title={`Delete ${deleteModal?.filename}?`}
        >
          {deleteModal && (
            <div className="space-y-4">
              <p className="text-sm text-[#a3a3a3]">
                This permanently removes the APK from the server. Devices that haven't yet downloaded it won't be able to. Devices that already installed it are unaffected.
              </p>
              <div className="text-xs text-[#737373] bg-[#0f0f0f] rounded p-3">
                <div>Package: <span className="text-white">{deleteModal.package}</span></div>
                <div>Version: <span className="text-white">v{deleteModal.version}</span></div>
                <div>Size: <span className="text-white">{fmtSize(deleteModal.sizeBytes)}</span></div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDeleteModal(null)}>Cancel</Button>
                <Button
                  className="bg-red-600 hover:bg-red-700"
                  onClick={() => deleteMut.mutate(deleteModal.filename)}
                  disabled={deleteMut.isPending}
                >
                  {deleteMut.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : <Trash2 size={14} className="mr-2" />}
                  Delete
                </Button>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </AppLayout>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
 * Minimal-deps fallbacks
 *
 * If your project doesn't have Card/Button/Modal/LoadingSpinner/AppLayout
 * components, you can paste these stubs into a local file and import them
 * instead of the kit imports above. They're rough but functional.
 *
 *   export const AppLayout = ({ children }) => <div>{children}</div>
 *   export const Card = ({ children, className = '' }) =>
 *     <div className={`border rounded ${className}`}>{children}</div>
 *   export const CardHeader = ({ title, action }) =>
 *     <div className="px-4 py-3 border-b flex justify-between">
 *       <h3 className="font-semibold">{title}</h3>{action}
 *     </div>
 *   export const CardContent = ({ children, className = '' }) =>
 *     <div className={`p-4 ${className}`}>{children}</div>
 *   export const Button = ({ children, ...p }) =>
 *     <button className="px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-50" {...p}>
 *       {children}
 *     </button>
 *   export const LoadingSpinner = () => <div>Loading…</div>
 *   export const Modal = ({ isOpen, onClose, title, children }) => isOpen ? (
 *     <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
 *       <div className="bg-white text-black rounded-lg p-6 max-w-md w-full">
 *         <div className="flex justify-between mb-4">
 *           <h2>{title}</h2><button onClick={onClose}>×</button>
 *         </div>
 *         {children}
 *       </div>
 *     </div>
 *   ) : null
 *
 * For useAuthStore — if you don't use Zustand, replace with whatever your
 * app uses to read the JWT. For example:
 *   const token = localStorage.getItem('auth_token')
 *   // or
 *   const token = useContext(AuthContext).token
 * ──────────────────────────────────────────────────────────────────────────── */
