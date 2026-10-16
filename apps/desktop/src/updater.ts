import { Notification, app } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from GitHub Releases (see electron-builder.yml). Only packaged
// builds check; development runs and end-to-end tests never do.

let started = false

export function startUpdates(log: (message: string) => void): void {
  if (started || !app.isPackaged || process.env.REBORN_E2E === '1' || process.env.REBORN_UPDATES === 'off') return
  started = true
  autoUpdater.logger = { info: (m: unknown) => log(`[update] ${String(m)}`), warn: (m: unknown) => log(`[update] ${String(m)}`), error: (m: unknown) => log(`[update] ${String(m)}`), debug: () => undefined }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    if (Notification.isSupported()) new Notification({ title: 'RE:BORN update ready', body: `Version ${info.version} installs when you quit.` }).show()
  })
  autoUpdater.on('error', (error) => log(`[update] ${error.message}`))
  void checkForUpdates(log)
}

export async function checkForUpdates(log: (message: string) => void): Promise<string> {
  if (!app.isPackaged) return 'Updates are checked in installed builds only.'
  try {
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo.version
    return latest && latest !== app.getVersion() ? `Downloading RE:BORN ${latest}.` : 'RE:BORN is up to date.'
  } catch (error) {
    log(`[update] ${String(error)}`)
    return 'Could not check for updates. See the log for details.'
  }
}
