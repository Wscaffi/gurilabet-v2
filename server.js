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

// Inicializa o Banco (Cria tabelas se não existirem)
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

// --- ROTA DE JOGOS (COM FILTRO DE DATA E AO VIVO) ---
app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        let url = '';
        const isAoVivo = req.query.aovivo === 'true';

        if (isAoVivo) {
            url = `https://v3.football.api-sports.io/fixtures?live=all`;
        } else {
            // Pega a data que veio do site ou usa a de hoje
            const dataFiltro = req.query.data || new Date().toISOString().split('T')[0];
            url = `https://v3.football.api-sports.io/fixtures?date=${dataFiltro}`;
        }

        // Timeout de 15s
        const resp = await axios.get(url, { headers, timeout: 15000 });
        
        let fixtures = resp.data.response;
        
        // Se a API bloquear ou vier vazia, usa o modo de emergência
        if (!fixtures || (fixtures.length === 0 && !isAoVivo && resp.data.errors && Object.keys(resp.data.errors).length > 0)) {
            throw new Error("Limite API ou Vazio");
        }
        
        if (!fixtures) fixtures = [];

        res.json(formatar(fixtures));

    } catch (e) {
        console.log("⚠️ Usando Backup de Jogos (API Off ou Limite)");
        // Se a API falhar, gera jogos para o dia solicitado para não ficar tela branca
        const dataBackup = req.query.data || new Date().toISOString().split('T')[0];
        res.json(gerarJogosBackup(dataBackup));
    }
});

function formatar(data) {
    const agora = new Date();
    return data.map(j => {
        const dataJogo = new Date(j.fixture.date);
        const status = j.fixture.status.short;
        const isFuturo = status === 'NS' || status === 'TBD';
        const isAoVivo = ['1H', '2H', 'HT', 'ET', 'P', 'BT'].includes(status);

        // Filtro básico: Mostra se for futuro ou ao vivo
        if (!isFuturo && !isAoVivo && status !== 'FT') return null;

        return montarObjeto(j);
    }).filter(j => j !== null);
}

function montarObjeto(j) {
    const ativo = ['NS', '1H', '2H', 'HT'].includes(j.fixture.status.short);
    
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
        ativo: ativo,
        odds: { 
            casa: (1.5 + Math.random()).toFixed(2), 
            empate: (3.0 + Math.random()).toFixed(2), 
            fora: (2.2 + Math.random() * 2).toFixed(2) 
        },
        mercados: {
            dupla_chance: { casa_empate: "1.25", casa_fora: "1.30", empate_fora: "1.60" },
            ambas_marcam: { sim: "1.75", nao: "1.95" },
            total_gols: { mais_05: "1.05", menos_05: "8.00", mais_15: "1.30", menos_15: "3.20", mais_25: "1.80", menos_25: "1.90", mais_35: "3.00", menos_35: "1.30" },
            placar_exato: { "1-0": "6.00", "2-0": "9.00", "2-1": "9.50", "0-0": "8.00", "0-1": "7.50" },
            intervalo_final: { "Casa/Casa": "2.50", "Empate/Empate": "4.50", "Fora/Fora": "5.00" },
            handicap: { "Casa -1": "2.80", "Empate -1": "3.40", "Fora +1": "1.45" },
            escanteios: { mais_8: "1.50", mais_10: "2.10", menos_10: "1.65" }
        }
    };
}

// --- ROTA DE LOGIN (ESSENCIAL) ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        // Criptografa a senha enviada para comparar com o banco
        const hash = crypto.createHash('sha256').update(senha).digest('hex');
        
        const result = await pool.query(
            'SELECT id, nome, saldo FROM usuarios WHERE email = $1 AND senha = $2', 
            [email, hash]
        );
        
        if (result.rows.length > 0) {
            res.json({ sucesso: true, usuario: result.rows[0] });
        } else {
            res.status(401).json({ erro: "Email ou senha incorretos." });
        }
    } catch (e) {
        res.status(500).json({ erro: "Erro no servidor." });
    }
});

// Rota de Cadastro
app.post('/api/cadastro', async (req, res) => {
    const { nome, email, senha } = req.body;
    const hash = crypto.createHash('sha256').update(senha).digest('hex');
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id, nome, saldo',
            [nome, email, hash]
        );
        res.json({ sucesso: true, usuario: result.rows[0] });
    } catch (e) { res.status(400).json({ erro: "E-mail já cadastrado." }); }
});

// Finalizar Aposta
app.post('/api/finalizar', async (req, res) => {
    const { usuario_id, valor, apostas, odd_total } = req.body;
    if (apostas.length > 10) return res.status(400).json({ erro: "Limite de 10 jogos excedido." });
    
    const codigo = "GB" + Math.floor(100000 + Math.random() * 900000);
    let retornoCalc = (valor * odd_total);
    if(retornoCalc > 2500) retornoCalc = 2500.00;
    const retornoFinal = parseFloat(retornoCalc).toFixed(2);
    
    const idUser = usuario_id || 1; // Usa ID 1 se for aposta avulsa

    try {
        await pool.query(
            'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
            [idUser, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
        );
        res.json({ sucesso: true, codigo, retorno: retornoFinal });
    } catch (e) { 
        // Se der erro de usuário não encontrado, cria um genérico e tenta de novo
        try {
            await pool.query("INSERT INTO usuarios (id, nome, email, senha) VALUES (1, 'Balcão', 'balcao@gurila.com', '123') ON CONFLICT DO NOTHING");
            await pool.query(
                'INSERT INTO bilhetes (usuario_id, codigo, valor, retorno, odds_total, detalhes) VALUES ($1, $2, $3, $4, $5, $6)',
                [1, codigo, valor, retornoFinal, odd_total, JSON.stringify(apostas)]
            );
            res.json({ sucesso: true, codigo, retorno: retornoFinal });
        } catch(err) { res.status(500).json({ erro: "Erro ao processar." }); }
    }
});

// Validador
app.get('/api/bilhete/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        const result = await pool.query(`SELECT b.*, u.nome as cliente FROM bilhetes b LEFT JOIN usuarios u ON b.usuario_id = u.id WHERE b.codigo = $1`, [codigo]);
        if(result.rows.length > 0) res.json({ sucesso: true, bilhete: result.rows[0] });
        else res.json({ sucesso: false, erro: "Bilhete não encontrado" });
    } catch(e) { res.status(500).json({ erro: e.message }); }
});

// --- GERADOR DE BACKUP (Para o site não ficar vazio hoje) ---
function gerarJogosBackup(dataStr) {
    const times = [ {n:"Flamengo",l:"https://media.api-sports.io/football/teams/127.png"}, {n:"Palmeiras",l:"https://media.api-sports.io/football/teams/121.png"}, {n:"Real Madrid",l:"https://media.api-sports.io/football/teams/541.png"}, {n:"Barcelona",l:"https://media.api-sports.io/football/teams/529.png"} ];
    const ligas = [ {n:"Brasileirão Série A",p:"Brazil",f:"https://media.api-sports.io/flags/br.svg"}, {n:"La Liga",p:"Spain",f:"https://media.api-sports.io/flags/es.svg"} ];
    
    let lista = [];
    let hora = 19;
    for(let i=0; i<6; i++) {
        let t1 = times[Math.floor(Math.random()*times.length)];
        let t2 = times[Math.floor(Math.random()*times.length)];
        if(t1==t2) t2 = times[(times.indexOf(t2)+1)%times.length];
        let l = ligas[i%2];
        let d = new Date(dataStr); d.setHours(hora+i, 0, 0);
        
        lista.push(montarObjeto({
            fixture: { id: 5000+i, date: d.toISOString(), status: { short: "NS" } },
            league: { name: l.n, country: l.p, flag: l.f },
            teams: { home: { name: t1.n, logo: t1.l }, away: { name: t2.n, logo: t2.l } }
        }));
    }
    return lista;
}

app.listen(process.env.PORT || 3000);
