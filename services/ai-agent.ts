
import { GoogleGenAI, Type } from "@google/genai";
import { Trade, Candle } from "../types";

export interface AISupervision {
  shouldClose: boolean;
  reason: string;
  adjustment?: 'HOLD' | 'REDUCE' | 'EXIT';
}

export const aiAgent = {
  getLessons(): string[] {
    const stored = localStorage.getItem('QUANT_AI_LESSONS');
    return stored ? JSON.parse(stored) : [];
  },

  addLesson(lesson: string) {
    const lessons = this.getLessons();
    lessons.push(`${new Date().toLocaleTimeString()}: ${lesson}`);
    localStorage.setItem('QUANT_AI_LESSONS', JSON.stringify(lessons.slice(-30)));
  },

  async learnFromTrade(trade: Trade, exitPrice: number) {
    try {
      if (!process.env.API_KEY) return;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const pnl = trade.pnl;
      const result = pnl > 0 ? "ÉXITO" : "FALLO";
      
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Analiza este trade: ${trade.symbol} (${result}). 
        Entrada: ${trade.entryPrice}, Salida: ${exitPrice}. 
        Resume en 1 frase técnica por qué el mercado absorbió o impulsó el precio. Habla de Liquidez y Order Flow.`,
      });

      if (response.text) {
        this.addLesson(response.text.trim());
      }
    } catch (e) {}
  },

  async superviseTrade(trade: Trade, recentCandles: Candle[]): Promise<AISupervision | null> {
    try {
      if (!process.env.API_KEY) return { shouldClose: false, reason: 'No API Key' };
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const lessons = this.getLessons();
      
      const context = {
        symbol: trade.symbol,
        side: trade.side,
        entry: trade.entryPrice,
        current: recentCandles[recentCandles.length-1].close,
        memory: lessons.slice(-3)
      };

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: `Actúa como un Monitor de Riesgos. Evalúa: ${JSON.stringify(context)}. 
        Veta si el volumen desaparece o hay absorción clara en contra.
        Responde SOLO JSON con shouldClose (boolean), reason (string), adjustment (enum).`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              shouldClose: { type: Type.BOOLEAN },
              reason: { type: Type.STRING },
              adjustment: { type: Type.STRING, enum: ['HOLD', 'REDUCE', 'EXIT'] }
            },
            required: ["shouldClose", "reason", "adjustment"]
          }
        }
      });

      return response.text ? JSON.parse(response.text) : { shouldClose: false, reason: 'AI Parse Error' };
    } catch (error) {
      console.warn("AI Supervision unavailable, bypassing...");
      return { shouldClose: false, reason: 'AI Error Bypass' };
    }
  }
};
