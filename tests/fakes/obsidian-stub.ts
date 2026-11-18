// Minimal stub so core tests can run in Node without the real Obsidian package.
// Only add what tests actually import from "obsidian".
export class Plugin {}
export class Modal {}
export class Notice {}
export class Setting {}
export class PluginSettingTab {}
export class ItemView {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export const normalizePath = (p: string) => p.replace(/\\/g, "/");
