import type { RepairToolApi } from './index'

declare global {
  interface Window {
    repairTool: RepairToolApi
  }
}
