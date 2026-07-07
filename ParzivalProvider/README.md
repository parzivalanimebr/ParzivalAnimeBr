# ParzivalAnimeBr - Nuvio Provider (v3.0.0)

## O que mudou

Isso **não é mais um addon Stremio** (servidor HTTP). É um **Nuvio Provider nativo**:
um arquivo JavaScript que roda **dentro do próprio app** (motor Hermes/React Native).

Isso resolve o problema de vez, porque:
- Cada stream pode ter um campo `headers` (Referer, User-Agent) que o **player nativo
  do Nuvio usa de verdade** ao buscar o vídeo — sem depender de proxy, sem CORS.
- Não precisa mais de Vercel, Railway, nem nenhum servidor. Roda 100% local no
  celular/TV do usuário.

---

## ⚠️ Passo obrigatório antes de usar: chave da TMDB

O provider recebe da Nuvio apenas o `tmdbId` (ID da TMDB), não o nome do anime.
Por isso, é necessário buscar o nome pela API da TMDB.

1. Crie uma conta grátis em https://www.themoviedb.org/
2. Vá em **Configurações → API** e gere sua **API Key (v3 auth)**
3. Abra `providers/parzivalanimebr.js` e substitua:
   ```js
   var TMDB_API_KEY = "COLE_SUA_CHAVE_TMDB_AQUI";
   ```
   pela sua chave real.

Sem isso, o provider não consegue descobrir o nome do anime e retorna 0 streams.

---

## Como instalar no Nuvio

1. Suba esta pasta inteira para um repositório no **GitHub** (público)
2. No Nuvio, adicione o repositório usando a URL raw do `manifest.json`, por exemplo:
   ```
   https://raw.githubusercontent.com/SEU_USUARIO/SEU_REPO/refs/heads/main/manifest.json
   ```
3. O Nuvio vai listar o provider "ParzivalAnimeBr" — ative-o

---

## Como testar antes de publicar (Plugin Tester)

1. Baixe a versão **debug** do Nuvio (aba Releases do GitHub oficial do Nuvio)
2. No app: **Configurações → Developer → Plugin Tester**
3. Aba "Individual Plugin":
   - Cole a URL raw do `providers/parzivalanimebr.js` OU cole o código direto
   - Preencha TMDB ID, tipo (tv/movie), temporada e episódio
   - Toque em **Run Test**
4. Veja os logs na aba "Logs" e os resultados na aba "Results"
5. Toque em **Play** num resultado pra confirmar que reproduz de verdade

---

## Limitações conhecidas

- **Numeração de episódio**: o TopAnimes numera episódios de forma absoluta
  (não por temporada). Para animes com várias temporadas, o parâmetro `episode`
  é usado diretamente — pode não bater com o número real do episódio absoluto
  em alguns casos. Se notar isso, me avisa que ajusto a lógica de conversão.
- **AnimesDigital.org removido**: estava bloqueando 100% das requisições
  (proteção anti-bot). Pode ser reintroduzido futuramente.
- **Iframes não suportados** (ex: players com JS muito ofuscado) simplesmente
  não geram stream — não há fallback de "abrir no navegador" nesse formato de
  provider (diferente do addon Stremio antigo).

---

## Estrutura

```
ParzivalProvider/
├── manifest.json                    # Lista o provider pro Nuvio
└── providers/
    └── parzivalanimebr.js           # O provider (sem async/await, sem deps externas)
```
