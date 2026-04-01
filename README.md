# <p align="center">🏠 homebridge-tuya-matter</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/homebridge-tuya-matter?color=blue&label=version&style=for-the-badge" alt="NPM Version">
  <img src="https://img.shields.io/badge/Homebridge-2.0%20%E2%89%A5%20beta.75-orange?style=for-the-badge" alt="Homebridge 2.0">
  <img src="https://img.shields.io/badge/Matter-Beta%20Support-green?style=for-the-badge" alt="Matter Support">
  <img src="https://img.shields.io/github/license/talrhv/homebridge-tuya-matter?style=for-the-badge" alt="MIT License">
<img src="https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins" alt="Homebridge Verified">
</p>

---

### The Next-Generation Tuya Integration
**homebridge-tuya-matter** is a high-performance, modern rewrite of the legacy Tuya platform. Rebuilt from the ground up with clean syntax and optimized logic, it introduces **Native Matter Bridging** for your Tuya ecosystem, delivering faster local-first execution and superior stability.

> [!TIP]
> **Broad Compatibility:** While engineered for the future of Matter (Homebridge 2.0+), this plugin is designed to support **Homebridge 1.3+** for standard HAP operation. 
> *Note: Legacy support for 1.3+ is currently experimental/untested and does not include Matter features.*

---

## 🚀 Key Improvements

* **Native Matter Stack:** Bridges your devices directly via the Homebridge 2.0 Matter Controller.
* **Modern ESM Rewrite:** A clean-sheet codebase using modern JavaScript, discarding years of legacy technical debt.
* **Enhanced Device Logic:** Specialized support for Fingerbots, ZigBee Curtain Switches (clkg), and improved multi-channel relays.

---

## 🛠 Installation (Homebridge UI)

The easiest way to install the plugin is through the official **Homebridge Web Interface**:

1. Open your Homebridge dashboard.
2. Navigate to the **Plugins** tab.
3. Search for **`homebridge-tuya-matter`**.
4. Click **Install**.
5. Restart Homebridge and follow the configuration steps in the UI.

*Note: Since this is currently in beta, look for the version tagged as `@beta` in the search results if you want the latest Matter features.*

---

##  📜 Disclaimer & Credits
**homebridge-tuya-matter is an independent project developed by Tal Rahav.**

Credits: This plugin is based on the foundation of the official Tuya Homebridge Platform but has been completely rewritten and expanded with modern features.

Disclaimer: This is not an official product of Tuya Inc. Use this software at your own risk.

Beta Notice: Native Matter support requires Homebridge v2.0.0-beta.75 or higher. While functional, Matter features are in beta and may have limited compatibility with certain device types as the API matures.

Legacy Support: Support for Homebridge 1.3+ is included in the codebase but has not been extensively tested.
