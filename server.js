const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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
        console.log("✅ Banco Gurila Bet Conectado!");
    } catch (e) { console.error("Erro Banco:", e.message); }
}
initDb();

// --- ROTA DE JOGOS BLINDADA (COM MODO OFF-LINE) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        // Tenta pegar da API Oficial
        let url = '';
        let isAoVivo = req.query.aovivo === 'true';
        
        if (isAoVivo) {
            url = `https://v3.football.api-sports.io/fixtures?live=all`;
        } else {
            const hoje = new Date().toISOString().split('T')[0];
            const dataFiltro = req.query.data || hoje;
            url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        }

        const resp = await axios.get(url, { headers, timeout: 10000 });
        
        // Verifica se a API retornou erro de limite ou lista vazia
        if (resp.data.errors && Object.keys(resp.data.errors).length > 0) {
            console.log("⚠️ Limite da API excedido! Usando dados falsos.");
            throw new Error("Limite Excedido");
        }

        let fixtures = resp.data.response;
        
        // Se a lista vier vazia e for dia de hoje, pode ser erro da API também
        if (!fixtures || fixtures.length === 0) {
             // Se for busca normal (não ao vivo) e retornou vazio, usa fake pra não ficar feio
             if(!isAoVivo) throw new Error("Lista Vazia - Usando Fake");
             else fixtures = [];
        }

        res.json(formatar(fixtures));

    } catch (e) {
        console.log("⚠️ Ativando Modo de Emergência (Jogos Falsos)");
        // MODO DE EMERGÊNCIA: GERA JOGOS FALSOS PARA TESTE
        const jogosFalsos = gerarJogosFalsos(req.query.data || new Date().toISOString().split('T')[0]);
        res.json(jogosFalsos);
    }
});

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        const isFuturo = status === 'NS' && dataJogo > agora;
        const isAoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'BT'].includes(status);

        if (!isFuturo && !isAoVivo) return null;

        return montarObjetoJogo(j);
    }).filter(j => j !== null);
}

// Função auxiliar para montar o objeto padrão
function montarObjetoJogo(j) {
    return {
        id: j.fixture.id,
        liga: j.league.name,
        logo_liga: j.league.logo,
        pais: j.league.country,
        bandeira_pais: j.league.flag || j.league.logo,
        home: { name: j.teams.home.name, logo: j.teams.home.logo },
        away: { name: j.teams.away.name, logo: j.teams.away.logo },
        data: j.fixture.date,
        status: j.fixture.status.short,
        ativo: true,
        odds: { 
            casa: (1.5 + Math.random()).toFixed(2), 
            empate: (3.0 + Math.random()).toFixed(2), 
            fora: (2.2 + Math.random() * 2).toFixed(2) 
        },
        mercados: {
            dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
            ambas_marcam: { sim: "1.75", nao: "1.95" },
            total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
            placar_exato: { "1-0": "6.00", "2-0": "9.00", "2-1": "9.50" },
            intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
        }
    };
}

// --- GERADOR DE JOGOS FALSOS (PARA QUANDO A API CAIR) ---
function gerarJogosFalsos(dataEscolhida) {
    const times = [
        {n: "Flamengo", l: "https://media.api-sports.io/football/teams/127.png"},
        {n: "Vasco", l: "https://media.api-sports.io/football/teams/133.png"},
        {n: "Palmeiras", l: "https://media.api-sports.io/football/teams/121.png"},
        {n: "Corinthians", l: "https://media.api-sports.io/football/teams/131.png"},
        {n: "São Paulo", l: "https://media.api-sports.io/football/teams/126.png"},
        {n: "Real Madrid", l: "https://media.api-sports.io/football/teams/541.png"},
        {n: "Barcelona", l: "https://media.api-sports.io/football/teams/529.png"},
        {n: "Man City", l: "https://media.api-sports.io/football/teams/50.png"},
        {n: "Liverpool", l: "https://media.api-sports.io/football/teams/40.png"},
        {n: "PSG", l: "https://media.api-sports.io/football/teams/85.png"}
    ];

    const ligas = [
        {n: "Brasileirão Série A", p: "Brazil", f: "https://media.api-sports.io/flags/br.svg"},
        {n: "Premier League", p: "England", f: "https://media.api-sports.io/flags/gb.svg"},
        {n: "La Liga", p: "Spain", f: "https://media.api-sports.io/flags/es.svg"},
        {n: "UEFA Champions League", p: "World", f: "https://media.api-sports.io/flags/eu.svg"}
    ];

    let lista = [];
    let hora = 14; 

    // Gera 10 jogos falsos
    for(let i=0; i<10; i++) {
        let t1 = times[Math.floor(Math.random() * times.length)];
        let t2 = times[Math.floor(Math.random() * times.length)];
        let liga = ligas[Math.floor(Math.random() * ligas.length)];
        
        // Evita time contra ele mesmo
        if(t1.n === t2.n) t2 = times[(times.indexOf(t2) + 1) % times.length];

        // Define data para HOJE mais tarde ou data escolhida
        let dataJogo = new Date(dataEscolhida);
        dataJogo.setHours(hora + i, 0, 0); // Espalha os horários

        lista.push({
            id: 1000 + i, // ID falso
            liga: liga.n,
            logo_liga: "https://media.api-sports.io/football/leagues/71.png",
            pais: liga.p,
            bandeira_pais: liga.f,
            home: { name: t1.n, logo: t1.l },
            away: { name: t2.n, logo: t2.l },
            data: dataJogo.toISOString(),
            status: "NS",
            ativo: true,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.0 + Math.random()).toFixed(2), 
                fora: (2.2 + Math.random() * 2).toFixed(2) 
            },
            mercados: {
                dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
                ambas_marcam: { sim: "1.75", nao: "1.95" },
                total_gols: { mais_15: "1.30", menos_15: "3.20", mais_25: "1.90", menos_25: "1.80" },
                placar_exato: { "1-0": "6.00", "2-0": "9.00", "2-1": "9.50" },
                intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" }
            }
        });
    }
    return lista;
}

// ROTA DE VALIDAÇÃO
app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const result = await pool.query(`
            SELECT b.*, u.nome as cliente 
            FROM bilhetes b 
            LEFT JOIN usuarios u ON b.usuario_id = u.id 
            WHERE b.codigo = $1
        `, [codigo]);
        
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false, erro: "Bilhete não encontrado" });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/api/cadastro', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;
        const hash = crypto.createHash('sha256').update(senha).digest('hex');
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    if (apostas.length > 10) return res.status(400).json({ erro: "Limite de 10 jogos excedido." });
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    let retornoCalc = (valor * odd_total);
    if(retornoCalc > 2500) retornoCalc = 2500.00;
    const retornoFinal = parseFloat(retornoCalc).toFixed(2);
    
    // Tenta usar ID 1 se não tiver usuário logado
    const idUser = usuario_id || 1;

    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [idUser, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoFinal });
    } catch (e) { 
        // Cria usuário padrão se der erro de chave
        try {
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Cliente Balcão', 'cli@gurila.com', '123') ON CONFLICT DO NOTHING");
            await pool.query(
                'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
                [1, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
            );
            res.json({ sucesso: true, codigo, retorno: retornoFinal });
        } catch(err) { res.status(500).json({ erro: "Erro ao processar aposta" }); }
    }
});

app.listen(process.env.PORT || 3000);
