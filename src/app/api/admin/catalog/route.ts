import {NextRequest,NextResponse} from 'next/server';
import {requireHmac} from '@/lib/auth';
import {catalog} from '@/lib/runtime/catalog';
export const dynamic='force-dynamic';export const runtime='nodejs';
export async function GET(req:NextRequest){const auth=await requireHmac(req,{signQuery:true});if(!auth.ok)return auth.response;return NextResponse.json(catalog());}
