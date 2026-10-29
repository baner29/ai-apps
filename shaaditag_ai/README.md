# ShaadiTag AI — Culturally Resonant Indian Wedding Hashtag Studio

**ShaadiTag AI** is a full-stack React + TypeScript + Express web application engineered for Indian couples, wedding planners, and families. Instead of producing mechanical syllable splices (`#RahuPri2026`) or generic templates (`#RahulWedsPriya`), ShaadiTag AI uses [`src/data/indian_wedding_hashtags_template.json`](src/data/indian_wedding_hashtags_template.json) as its core knowledge base, system prompt specification, and dynamic few-shot Chain-of-Thought (CoT) reference library.

---

## ✨ Key Architecture & Features

### 1. Data & LLM Integration (`indian_wedding_hashtags_template.json`)
- **System Prompt Injection**: Initializes the LLM system prompt with `llm_system_prompt_template` and `creative_reasoning_taxonomy`, enforcing all 5 creative rules:
  1. *Bilingual Semantic Synthesis* (finding real Hindi, Urdu, Punjabi, Gujarati, or Sanskrit words hidden inside the couple's names, e.g., `#Nibaha`, `#SauMeinEk`).
  2. *Narrative & Personality Anchoring* (anchoring on shared obsessions, food, and how they met when names resist direct rhyming).
  3. *Phonetic Climax Subversion* (placing a name or surname on the final stressed beat of a familiar English idiom or Bollywood hook).
  4. *Cultural & Ritual Contextualization* (weaving in Haldi, Mehendi, Sangeet, Baraat, Pheras, Anand Karaj, or Nikah).
  5. *Safety & Usability Guardrails* (CamelCase formatting, `<= 22` character target, DJ read-aloud rhythm, and all-lowercase collision checks).
- **Dynamic Few-Shot Retrieval**: Filters all 50 `training_examples` before every generation to retrieve the **8–10 most relevant examples** based on shared surnames (`Patel`, `Gill`, `Singh`, `Sharma`, `Gogna`, etc.), shared suffixes (`-preet`, `-deep`, `-jot`), regional roots, and vibe, plus **2 top examples from each of the 5 creative categories**.
- **Structured JSON Output Schema**: Generates **10 hashtag packages** (2 across each of the 5 creative archetypes) with `primary_hashtag`, `companion_variations`, `creative_chain_of_thought`, and `contrastive_evaluation`.

### 2. Interactive Results Dashboard & Reference Library
- **Scannable Card Grid** grouped by the 5 creative archetypes, filterable by archetype or saved shortlist.
- **"Why This Works" Creative Reasoning Drawer**: Expandable drawer displaying `phonetic_and_lexical_hooks`, `cultural_or_emotional_anchor`, `transformation_logic`, and a **Contrastive Quality Check** comparing the winning tag against `naive_concatenation_rejected` and `shallow_wordplay_rejected`.
- **Automated Client-Side Usability & Safety Badges**:
  - **Lowercase Trap Auditor**: Renders the hashtag in all-lowercase (`#sidsnaggedsari`) next to a green check badge to verify no unintended words appear when uncapitalized.
  - **Length & Tap-Test Badge**: Green (`<= 20` chars: *"Easy for guests to type"*), neutral (`21–22` chars), or Amber (`> 22` chars: *"Consider shortening for mobile guests"*).
  - **Live Social Availability Check**: Direct button (`Check on Instagram`) opening `https://www.instagram.com/explore/tags/{hashtag_without_hash}/` in a new tab.
- **50-Example Reference Library Tab**: Browse, search, and filter all 50 curated examples from `indian_wedding_hashtags_template.json`.

### 3. Vertex AI (`gemini-3.8-flash`) - Vertex Only
- Configured for **Vertex AI (Agent Platform)** with `GOOGLE_GENAI_USE_VERTEXAI=True` (and `OOGLE_GENAI_USE_VERTEXAI=True`) and model `gemini-3.8-flash`, location `global`.
- Authentication is via Application Default Credentials (the Cloud Run service account). There is **no API-key path and no local fallback engine** - if Vertex AI is unavailable, the API returns an error.

---

## 🚀 Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Build the frontend and run the production Express + Vertex AI server on port 8080
npm run build
npm start

# Or run Vite dev server + Express API server concurrently during development:
npm run dev:full
```

---

## ☁️ Deploying to Google Cloud Run

```bash
chmod +x deploy-cloudrun.sh
./deploy-cloudrun.sh
```

Or run `gcloud` directly:

```bash
gcloud run deploy shaaditag-ai \
  --source . \
  --region northamerica-northeast2 \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=True,OOGLE_GENAI_USE_VERTEXAI=True,GOOGLE_CLOUD_PROJECT=banercorp-web,GOOGLE_CLOUD_LOCATION=us-central1,GEMINI_MODEL=gemini-3.8-flash"
```
