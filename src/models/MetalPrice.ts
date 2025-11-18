import mongoose, { Document, Schema } from 'mongoose';

export type MetalSymbol = 'gold' | 'silver';

export interface IMetalPrice extends Document {
  metalSymbol: MetalSymbol;
  price: number;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MetalPriceSchema = new Schema<IMetalPrice>(
  {
    metalSymbol: {
      type: String,
      enum: ['gold', 'silver'],
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
      min: [0, 'Price must be greater than or equal to 0'],
    },
    lastUpdated: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

MetalPriceSchema.index({ metalSymbol: 1 }, { unique: true });

export const MetalPrice = mongoose.model<IMetalPrice>('MetalPrice', MetalPriceSchema);


