import { createRemoteJWKSet, jwtVerify } from 'jose';

const PROJECT_ID='cq-mano-de-obra';
const ALLOWED_EMAILS=new Set(['emilio@cqgerencia.com','juan@cqgerencia.com']);
const JWKS=createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

function json(statusCode,body){
  return {
    statusCode,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store'
    },
    body:JSON.stringify(body)
  }
}

function getBearer(headers={}){
  const h=headers.authorization||headers.Authorization||'';
  const m=String(h).match(/^Bearer\s+(.+)$/i);
  return m?m[1]:'';
}

function extractText(r){
  if(typeof r?.output_text==='string'&&r.output_text.trim())
    return r.output_text.trim();

  const parts=[];
  for(const item of (r?.output||[])){
    for(const c of (item?.content||[])){
      if(typeof c?.text==='string')parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

async function verifyFirebaseToken(token){
  const {payload}=await jwtVerify(token,JWKS,{
    issuer:`https://securetoken.google.com/${PROJECT_ID}`,
    audience:PROJECT_ID,
    algorithms:['RS256']
  });

  const email=String(payload.email||'').toLowerCase();

  if(!ALLOWED_EMAILS.has(email))
    throw new Error('Usuario sin permiso para IA Gerencia');

  return {uid:payload.sub,email};
}

export async function handler(event){
  if(event.httpMethod!=='POST')
    return json(405,{error:'Método no permitido'});

  try{
    const token=getBearer(event.headers);

    if(!token)
      return json(401,{error:'Falta sesión de Gerencia'});

    await verifyFirebaseToken(token);

    const {question,context}=JSON.parse(event.body||'{}');

    if(!question||typeof question!=='string')
      return json(400,{error:'Falta la pregunta'});

    if(!context||typeof context!=='object')
      return json(400,{error:'Falta el contexto de datos'});

    const apiKey=process.env.OPENAI_API_KEY;

    if(!apiKey)
      return json(500,{
        error:'Falta configurar OPENAI_API_KEY en Netlify'
      });

    const payload={
      model:process.env.CQ_AI_MODEL||'gpt-5.6-luna',
      store:false,
      reasoning:{effort:'low'},
      max_output_tokens:1400,

      instructions:`Sos IA Gerencia de CQ Desarrollos, una empresa desarrollista de Córdoba, Argentina. Respondé en español rioplatense, claro, ejecutivo y concreto. Trabajás EXCLUSIVAMENTE con el JSON de contexto provisto para esta consulta. No inventes datos ni completes huecos con conocimiento externo. Si un dato no está en el contexto, decilo. Diferenciá ARS y USD. Cuando compares obras, nombrá las obras. Si detectás un riesgo o anomalía, explicá qué dato la sustenta. En Avances, el campo avanceItemsAproxPct es aproximado: nunca lo presentes como porcentaje ponderado exacto de la app. No sugieras ni ejecutes escrituras: esta etapa es solo lectura.`,

      input:[{
        role:'user',
        content:[{
          type:'input_text',
          text:`PREGUNTA:\n${question}\n\nDATOS CQ (JSON):\n${JSON.stringify(context)}`
        }]
      }]
    };

    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{
        'Authorization':`Bearer ${apiKey}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(payload)
    });

    const data=await r.json();

    if(!r.ok){
      console.error('OpenAI error',r.status,data);
      return json(502,{
        error:'La IA no pudo responder en este momento'
      });
    }

    const answer=extractText(data);

    if(!answer)
      return json(502,{error:'La IA respondió sin texto'});

    return json(200,{
      answer,
      model:payload.model
    });

  }catch(e){
    console.error('cq-ai',e);
    return json(401,{
      error:e?.message||'No se pudo validar la consulta'
    });
  }
}
