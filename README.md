# HealthIQ Backend

A TypeScript/Express backend for **HealthIQ**  an AI-powered personal health intelligence platform that tracks symptoms, medications, lifestyle events, and clinical data to provide health pattern analysis and smart recommendations.

## Features

- **Health Timeline Management**  Track and manage health events (symptoms, medications, lifestyle, clinical)
- **AI-Powered Symptom Interpretation**  Understand symptoms using LLM analysis
- **Health Pattern Analysis**  Discover trends and correlations in your health data
- **Medical Specialization Suggestions**  AI-recommended specialists based on health history
- **Doctor Visit Summarization**  Generate concise summaries of physician visits
- **Conversational Health Chat**  Natural language interface for health queries

## Tech Stack

- **Runtime:** Node.js (>=18)
- **Language:** TypeScript
- **Framework:** Express.js
- **AI Integration:** LLM-based health analysis

## Project Structure

```
backend/
 server.ts                     # Express server entry point
 ai/                           # AI/LLM integration modules
    DoctorVisitSummarizer.ts
    HealthChatHandler.ts
    HealthPatternAnalyzer.ts
    PromptBuilders.ts
    SpecializationSuggester.ts
    SymptomInterpreter.ts
 domain/                       # Domain models
    ClinicalEvent.ts
    EventSource.ts
    HealthEvent.ts
    HealthTimeline.ts
    InsightEvent.ts
    LifestyleEvent.ts
    MedicationEvent.ts
    SymptomEvent.ts
    VisibilityScope.ts
 maps/                         # Provider/location services
    MapsClient.ts
    ProviderDiscovery.ts
    SpecializationQueryMap.ts
 repository/                   # Data access layer
     InMemoryTimelineRepository.ts
     RepositoryFactory.ts
     TimelineRepository.ts
```

## Getting Started

`ash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start
`

## Environment Variables

Create a .env file with:

`env
PORT=3001
CORS_ORIGINS=*
`

## License

MIT
