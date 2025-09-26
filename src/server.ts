import Fastify from 'fastify';
import cors from '@fastify/cors';
import { OpenAIClient, AzureKeyCredential } from '@azure/openai';
import { SearchClient } from '@azure/search-documents';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const config = {
  port: parseInt(process.env.PORT || '8000'),
  host: '0.0.0.0',
  tenantId: process.env.TENANT_ID || '71416bf2-04a4-4715-a8d2-6af239168e20',
  clientId: process.env.CLIENT_ID || 'f0b0fbfa-3b0c-49a7-83ee-27ba1cbdcfe5',
  // Azure OpenAI
  azureOpenAI: {
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    key: process.env.AZURE_OPENAI_KEY || '',
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini'
  },
  // Azure Search
  azureSearch: {
    endpoint: process.env.AZURE_SEARCH_ENDPOINT || '',
    key: process.env.AZURE_SEARCH_KEY || '',
    indexName: process.env.AZURE_SEARCH_INDEX || 'techra-docs-index'
  }
};

// Types
interface UserInfo {
  email: string;
  name: string;
  tenantId: string;
  objectId: string;
  groups: string[];
}

interface ChatRequest {
  message: string;
  conversation_history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

interface SearchResult {
  content: string;
  source: string;
  score: number;
}

// Initialize Azure clients
let openAIClient: OpenAIClient | null = null;
let searchClient: SearchClient<any> | null = null;

if (config.azureOpenAI.endpoint && config.azureOpenAI.key) {
  openAIClient = new OpenAIClient(
    config.azureOpenAI.endpoint,
    new AzureKeyCredential(config.azureOpenAI.key)
  );
  console.log('✅ Azure OpenAI client initialized');
} else {
  console.warn('⚠️ Azure OpenAI not configured - chat will use mock responses');
}

if (config.azureSearch.endpoint && config.azureSearch.key) {
  searchClient = new SearchClient(
    config.azureSearch.endpoint,
    config.azureSearch.indexName,
    new AzureKeyCredential(config.azureSearch.key)
  );
  console.log('✅ Azure Search client initialized');
} else {
  console.warn('⚠️ Azure Search not configured - RAG features disabled');
}

// Initialize Fastify
const fastify = Fastify({ 
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// Authentication middleware
const authenticate = async (request: any, reply: any) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    const token = authHeader.substring(7);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8')
    );

    const user: UserInfo = {
      email: payload.upn || payload.email || payload.preferred_username || 'test@techra.app',
      name: payload.name || 'Test User',
      tenantId: payload.tid || config.tenantId,
      objectId: payload.oid || 'test-123',
      groups: payload.groups || ['d5f7f6e7-380f-468d-9d0e-6a7c30fd3ef9'] // Default to SUPERVISOR_GROUP
    };

    request.user = user;
  } catch (error) {
    // Development fallback
    request.user = {
      email: 'dev@techra.app',
      name: 'Development User',
      tenantId: config.tenantId,
      objectId: 'dev-123',
      groups: ['d5f7f6e7-380f-468d-9d0e-6a7c30fd3ef9']
    };
  }
};

// Search documents function
async function searchDocuments(query: string, top: number = 3): Promise<SearchResult[]> {
  if (!searchClient) {
    return [];
  }

  try {
    const searchResults = await searchClient.search(query, {
      top,
      select: ['content', 'metadata_storage_name'],
      searchMode: 'all',
      queryType: 'simple'
    });

    const results: SearchResult[] = [];
    for await (const result of searchResults.results) {
      results.push({
        content: result.document.content || '',
        source: result.document.metadata_storage_name || 'Unknown',
        score: result.score || 0
      });
    }

    return results;
  } catch (error) {
    console.error('Search error:', error);
    return [];
  }
}

// Setup server
async function setupServer() {
  // Register CORS
  await fastify.register(cors, {
    origin: [
      'https://www.techra.app',
      'https://techra-frontend.zealous-wave-0e1234567.1.azurestaticapps.net',
      'https://gentle-ocean-00c563303.1.azurestaticapps.net',
      'http://localhost:3000',
      'http://localhost:5173'
    ],
    credentials: true
  });

  // Health check
  fastify.get('/', async () => {
    return { 
      message: 'Techra TypeScript Backend API v2.1', 
      status: 'healthy',
      features: {
        openai: !!openAIClient,
        search: !!searchClient,
        rag: !!openAIClient && !!searchClient
      },
      timestamp: new Date().toISOString()
    };
  });

  fastify.get('/health', async () => {
    return {
      status: 'healthy',
      version: '2.1.0',
      timestamp: new Date().toISOString()
    };
  });

  // User info endpoint
  fastify.get('/me', { preHandler: authenticate }, async (request: any) => {
    return request.user;
  });

  // Main chat endpoint with RAG
  fastify.post('/chat', { preHandler: authenticate }, async (request: any, reply: any) => {
    try {
      const { message, conversation_history = [] } = request.body as ChatRequest;
      const user: UserInfo = request.user;

      // 1. Search for relevant documents
      const searchResults = await searchDocuments(message);
      
      // 2. Build context from search results
      let context = '';
      const sources: string[] = [];
      
      if (searchResults.length > 0) {
        context = 'Relevant information from documentation:\n\n';
        searchResults.forEach((result, idx) => {
          context += `[${idx + 1}] ${result.content}\n\n`;
          if (!sources.includes(result.source)) {
            sources.push(result.source);
          }
        });
      }

      // 3. Generate response with Azure OpenAI
      let aiResponse = '';
      
      if (openAIClient) {
        const messages = [
          {
            role: 'system' as const,
            content: `You are Techra AI Assistant, helping with train HVAC systems troubleshooting.
            User: ${user.name} (${user.email})
            Role: ${user.groups.includes('d5f7f6e7-380f-468d-9d0e-6a7c30fd3ef9') ? 'Supervisor' : 
                   user.groups.includes('5dc860e3-600d-4332-9200-5cdc53e7242b') ? 'Technician' : 'Viewer'}
            
            ${context ? `Use this documentation to answer:\n${context}` : 'No specific documentation found.'}
            
            Provide accurate, technical responses about train HVAC systems, maintenance, and troubleshooting.`
          },
          ...conversation_history.map(msg => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          })),
          {
            role: 'user' as const,
            content: message
          }
        ];

        const completion = await openAIClient.getChatCompletions(
          config.azureOpenAI.deployment,
          messages,
          {
            temperature: 0.7,
            maxTokens: 800,
            topP: 0.95
          }
        );

        aiResponse = completion.choices[0]?.message?.content || 'No response generated';
      } else {
        // Fallback for development
        aiResponse = `Mock response for: "${message}"\n\n` +
                     `Found ${searchResults.length} relevant documents.\n` +
                     `This is a development response. Configure Azure OpenAI for real responses.`;
      }

      return {
        user: message,
        reply: aiResponse,
        sources,
        conversation_history: [
          ...conversation_history,
          { role: 'user', content: message },
          { role: 'assistant', content: aiResponse }
        ]
      };

    } catch (error) {
      console.error('Chat error:', error);
      reply.code(500).send({ 
        error: 'Chat processing failed',
        details: process.env.NODE_ENV === 'development' ? error : undefined
      });
    }
  });

  // Legacy chat/query endpoint for compatibility
  fastify.post('/chat/query', { preHandler: authenticate }, async (request: any) => {
    const { query } = request.body;
    // Redirect to main chat endpoint
    return fastify.inject({
      method: 'POST',
      url: '/chat',
      headers: request.headers,
      payload: { message: query }
    }).then(response => response.json());
  });

  // Debug endpoint (only in development)
  if (process.env.NODE_ENV === 'development') {
    fastify.get('/debug/config', { preHandler: authenticate }, async () => {
      return {
        openai_configured: !!config.azureOpenAI.endpoint,
        search_configured: !!config.azureSearch.endpoint,
        tenant_id: config.tenantId,
        client_id: config.clientId
      };
    });
  }

  return fastify;
}

// Start server
const start = async () => {
  try {
    const server = await setupServer();
    await server.listen({ port: config.port, host: config.host });
    console.log(`🚀 Server running on http://${config.host}:${config.port}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'production'}`);
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

start();
