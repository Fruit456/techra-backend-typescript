# Techra Backend TypeScript

## Azure Container App Backend with RAG (Retrieval-Augmented Generation)

### Features
- FastAPI-style endpoints with Fastify
- Azure AD authentication
- Azure OpenAI integration for chat
- Azure Cognitive Search for document retrieval
- TypeScript with full type safety

### Environment Variables
AZURE_OPENAI_ENDPOINT=https://aoai-techra.openai.azure.com/
AZURE_OPENAI_KEY=your-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o-mini
AZURE_SEARCH_ENDPOINT=https://search-techra.search.windows.net
AZURE_SEARCH_KEY=your-key
AZURE_SEARCH_INDEX=techra-docs-index

### Development
npm install
npm run dev

### Production Build
npm run build
npm start

### Docker Build
docker build -t techra-backend .
docker run -p 8000:8000 techra-backend
