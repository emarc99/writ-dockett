/** Rejection reason bits by the labels the workflow logs; mirrors Reason in workflows/writ/legal.ts. */
const Reason: Record<string, number> = {
	DocketNotFound: 1,
	EntryNotFound: 2,
	NotAnOrder: 4,
	HashMismatch: 8,
	WalletNotInOrder: 16,
	NoWallets: 32,
	DateMismatch: 64,
	AlreadyExpired: 128,
}

export const reasonLabelsToBits = (labels: string[]) => labels.reduce((acc, label) => acc | (Reason[label] ?? 0), 0)
