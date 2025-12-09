# Documentation for n8n Visual Fatigue Diagnosis Workflow

This document outlines the structure and functionality of the "Visual Fatigue Diagnosis Flow," an n8n workflow designed to analyze and diagnose visual fatigue based on biometric data.

## Workflow Overview

The workflow is triggered by an HTTP POST request and leverages a Google Gemini AI model to provide a detailed diagnosis comparing initial and final measurements of visual fatigue indicators.

### 1. Webhook (Trigger)

*   **Name:** `Webhook`
*   **Type:** `n8n-nodes-base.webhook`
*   **Functionality:**
    *   Initiates the workflow upon receiving an HTTP `POST` request.
    *   The webhook listens on the path: `/visual-fatigue-diagnosis`.
    *   It expects a JSON body containing the initial and final measurements.

### 2. AI Agent

*   **Name:** `AI Agent`
*   **Type:** `@n8n/n8n-nodes-langchain.agent`
*   **Functionality:**
    *   Acts as an expert ophthalmologist AI.
    *   Receives the patient's data from the webhook.
    *   The agent's prompt instructs it to analyze the evolution of visual fatigue by comparing the `medicion_inicial` and `medicion_final`.
    *   It is instructed to generate a comprehensive diagnosis in a strict JSON format.

### 3. Google Gemini Chat Model

*   **Name:** `Google Gemini Chat Model`
*   **Type:** `@n8n/n8n-nodes-langchain.lmChatGoogleGemini`
*   **Model:** `models/gemini-2.0-flash`
*   **Functionality:**
    *   This is the Large Language Model that powers the `AI Agent`.
    *   It receives the formatted prompt and data from the agent and generates the textual diagnosis.

### 4. Code in JavaScript

*   **Name:** `Code`
*   **Type:** `n8n-nodes-base.code`
*   **Functionality:**
    *   This node is a critical data processing step.
    *   It receives the raw text output from the AI model.
    *   It uses a regular expression to extract the JSON object from the AI's response.
    *   It parses the extracted JSON string into a structured JSON object.
    *   This ensures that the final output is a clean and valid JSON, handling any extraneous text from the AI.

### 5. Respond to Webhook

*   **Name:** `Respond to Webhook`
*   **Type:** `n8n-nodes-base.respondToWebhook`
*   **Functionality:**
    *   This is the final node in the workflow.
    *   It sends the clean JSON diagnosis (processed by the `Code` node) back to the client that initiated the request.

## Data Flow

1.  A client sends a `POST` request to `/visual-fatigue-diagnosis` with a JSON body containing `inicial` and `final` measurement data.
2.  The `Webhook` node receives the data and passes it to the `AI Agent`.
3.  The `AI Agent` uses the `Google Gemini Chat Model` to generate a diagnosis based on the provided data.
4.  The `Code` node extracts and parses the JSON diagnosis from the AI's response.
5.  The `Respond to Webhook` node returns the final JSON diagnosis to the client.

## Expected Input JSON Structure

```json
{
  "inicial": {
    "usuario_id": "some_user_id",
    "perclos": 0.2,
    "sebr": 15,
    "num_bostezos": 2,
    "tiempo_cierre": 0.25,
    "velocidad_ocular": 120,
    "nivel_subjetivo": 3
  },
  "final": {
    "perclos": 0.5,
    "sebr": 10,
    "num_bostezos": 5,
    "tiempo_cierre": 0.4,
    "velocidad_ocular": 100,
    "nivel_subjetivo": 7
  }
}
```
