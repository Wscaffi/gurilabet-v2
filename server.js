const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // Libera acesso de qualquer lugar (Front)

// --- SISTEMA DE CACHE (ECONOMIA DE API) ---
// Guarda os jogos na memória por 15 minutos para não gastar requisições à toa
let cacheJogos = {
    dados: null,
    ultimaAtualizacao: 0
};
const TEMPO_CACHE = 15 * 60 * 1000; // 15 Minutos

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Garante conexão com Railway
});

// --- INICIALIZAÇÃO DO BANCO ---
async function initDb() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY, nome TEXT, email TEXT UNIQUE, senha TEXT, saldo NUMERIC DEFAULT 0.00
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS bilhetes (
            id SERIAL PRIMARY KEY, usuario_id INTEGER, codigo TEXT UNIQUE, 
            valor NUMERIC, retorno NUMERIC, odds_total NUMERIC, status TEXT DEFAULT 'pendente', 
            detalhes JSONB, data TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Cria usuário Balcão se não existir
        const userCheck = await pool.query("SELECT id FROM usuarios WHERE id = 1");
        if(userCheck.rows.length === 0) {
            const hash = await bcrypt.hash('sistema123', 10);
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'sistema@gurila.com', $1)", [hash]);
        }
        console.log("✅ Banco de Dados Conectado e Otimizado!");
    } catch (e) { console.error("⚠️ Aviso Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS (COM CACHE E DUPLA SEGURANÇA) ---
app.get('/api/jogos', async (req, res) => {
    const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
    const isAoVivo = req.query.aovivo === 'true';
    const agora = Date.now();

    // 1. VERIFICA CACHE (Economia de Dinheiro)
    // Se não for Ao Vivo e o cache for recente, usa ele.
    if (!isAoVivo && cacheJogos.dados && (agora - cacheJogos.ultimaAtualizacao < TEMPO_CACHE)) {
        console.log("🚀 Usando Cache (Economizando API)");
        return res.json(cacheJogos.dados);
    }
    
    try {
        console.log(`🌍 Buscando na API Oficial para: ${dataFiltro}`);
        
        if (!process.env.API_FOOTBALL_KEY) throw new Error("Sem Chave API");

        // Envia as duas chaves possíveis para garantir conexão
        const headers = { 
            'x-apisports-key': process.env.API_FOOTBALL_KEY.trim(),
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY.trim(),
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        let url = isAoVivo 
            ? `https://v3.football.api-sports.io/fixtures?live=all`
            : `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;

        const resp = await axios.get(url, { headers, timeout: 6000 });
        
        // Verifica se a API bloqueou a conta
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            console.error("❌ Erro API:", JSON.stringify(resp.data.errors));
            throw new Error("Erro na conta da API");
        }

        let fixtures = resp.data.response;
        if (!fixtures || fixtures.length === 0) throw new Error("Lista vazia na API");

        const jogosReais = formatar(fixtures);
        if (jogosReais.length === 0) throw new Error("Jogos filtrados");

        // ATUALIZA O CACHE
        if (!isAoVivo) {
            cacheJogos = { dados: jogosReais, ultimaAtualizacao: agora };
        }

        console.log(`✅ Sucesso! Enviando ${jogosReais.length} jogos.`);
        res.json(jogosReais);

    } catch (e) {
        console.log(`⚠️ Falha na API (${e.message}). Ativando Modo Backup.`);
        // Tenta usar cache antigo antes de ir pro fake
        if (cacheJogos.dados) return res.json(cacheJogos.dados);
        
        res.json(gerarJogosFalsos(dataFiltro));
    }
});

// --- ROTA FINALIZAR APOSTA (BLINDADA) ---
app.post('/api/finalizar', async (req, res) => {
    let { usuario_id, valor, apostas, odd_total } = req.body;
    
    // 🛡️ TRAVA 1: Valor Negativo
    valor = parseFloat(valor);
    if (!valor || valor <= 0) return res.status(400).json({ erro: "Valor inválido." });

    // 🛡️ TRAVA 2: Odd Manipulada (Hack)
    // Se tentarem enviar odd 5000 manual, o sistema corta para 2000
    odd_total = parseFloat(odd_total);
    if (odd_total > 2000) odd_total = 2000.00;

    // 🛡️ TRAVA 3: Teto de Pagamento
    let retorno = valor * odd_total;
    const TETO_MAXIMO = 5000.00; // Máximo que a casa paga por bilhete
    if (retorno > TETO_MAXIMO) retorno = TETO_MAXIMO;

    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    
    try {
        await pool.query('INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)', 
        [usuario_id || 1, codigo, valor, retorno.toFixed(2), odd_total, JSON.stringify(apostas)]);
        
        console.log(`💰 Aposta Criada: ${codigo} | R$ ${valor} -> R$ ${retorno.toFixed(2)}`);
        res.json({ sucesso: true, codigo, retorno: retorno.toFixed(2) });
    } catch (e) { 
        res.status(500).json({ erro: "Erro ao processar aposta." }); 
    }
});

// --- ROTA ADMINISTRATIVA (PAINEL DO DONO) ---
// Acesse via navegador: seu-site.com/api/admin/resumo?senha=admin_gurila_2026
app.get('/api/admin/resumo', async (req, res) => {
    const senha = req.query.senha;
    if (senha !== 'admin_gurila_2026') { // Mude essa senha depois!
        return res.status(403).json({ erro: "Acesso Negado 👮‍♂️" });
    }

    try {
        const financeiro = await pool.query(`SELECT COUNT(*) as total_bilhetes, SUM(valor) as entrada_total, SUM(retorno) as risco_total FROM bilhetes`);
        const ultimos = await pool.query(`SELECT codigo, valor, retorno, data FROM bilhetes ORDER BY data DESC LIMIT 5`);

        res.json({
            status: "Operacional 🟢",
            caixa: {
                apostas: financeiro.rows[0].total_bilhetes,
                entrada: `R$ ${parseFloat(financeiro.rows[0].entrada_total || 0).toFixed(2)}`,
                risco_maximo: `R$ ${parseFloat(financeiro.rows[0].risco_total || 0).toFixed(2)}`
            },
            ultimas_apostas: ultimos.rows
        });
    } catch (e) { res.status(500).json({ erro: "Erro admin" }); }
});

// --- FUNÇÕES AUXILIARES ---
function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        if (['FT', 'AET', 'PEN'].includes(status)) return null;
        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            ativo: true,
            odds: { 
                casa: (1.5 + (j.fixture.id % 10)/20).toFixed(2), 
                empate: (3.0 + (j.fixture.id % 5)/10).toFixed(2), 
                fora: (2.2 + (j.fixture.id % 8)/10).toFixed(2) 
            },
            mercados: gerarMercadosPadrao()
        };
    }).filter(Boolean);
}

function gerarJogosFalsos(dataBase) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Vasco", l: "https://media.api-sports.io/football/teams/133.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"}
    ];
    let lista = [];
    for(let i=0; i<12; i++) {
        let t1 = times[Math.floor(Math.random() * times.length)];
        let t2 = times[Math.floor(Math.random() * times.length)];
        if(t1.n === t2.n) t2 = times[(times.indexOf(t2) + 1) % times.length];
        
        let dataJogo = new Date(dataBase);
        dataJogo.setHours(13 + i, 0, 0); 
        if(new Date() > dataJogo) dataJogo.setDate(dataJogo.getDate() + 1);

        lista.push({
            id: 9000 + i, liga: "Brasileirão", logo_liga: "https://media.api-sports.io/football/leagues/71.png",
            pais: "Brazil", bandeira_pais: "https://media.api-sports.io/flags/br.svg",
            home: { name: t1.n, logo: t1.l }, away: { name: t2.n, logo: t2.l },
            data: dataJogo.toISOString(), status: "NS", ativo: true,
            odds: { casa: "1.90", empate: "3.20", fora: "2.50" },
            mercados: gerarMercadosPadrao()
        });
    }
    return lista;
}

function gerarMercadosPadrao() {
    return {
        dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
        ambas_marcam: { sim: "1.75", nao: "1.95" },
        total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
        intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
    };
}

// Rotas Padrão (Cadastro, Login, Bilhete)
app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        if(!email || !senha) return res.status(400).json({ erro: "Dados inválidos." });
        const hash = await bcrypt.hash(senha, 10);
        const result = await pool.query('INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo', [nome, email, hash]);
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { if(e.code === '23505') return res.status(400).json({ erro: "E-mail já cadastrado." }); res.status(500).json({ erro: "Erro servidor." }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ erro: "Login falhou." });
        const user = result.rows[0];
        if (!(await bcrypt.compare(senha, user.senha))) return res.status(400).json({ erro: "Login falhou." });
        delete user.senha;
        res.json({ sucesso: true, usuario: user });
    } catch (e) { res.status(500).json({ erro: "Erro Login" }); }
});

app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [req.params.codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false });
    } catch(e) { res.status(500).json({ erro: "Erro" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("🔥 Server On!"));
