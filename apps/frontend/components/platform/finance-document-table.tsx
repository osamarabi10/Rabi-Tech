'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  FileText,
  Loader2,
  Plus,
  Receipt,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * One subscriber's finance ledger: what they owe, and what they have paid.
 *
 * The console could suspend an account for non-payment and had nowhere to see
 * whether payment had in fact been taken. Both document kinds live in one table
 * on purpose — a receipt and the invoice it settles are the same event a few
 * days apart, and two separate lists would leave the reader interleaving them
 * by eye.
 *
 * Nothing here is a tax document, and the disclaimer at the foot is not
 * decoration: the platform owner must not hand one of these to an accountant
 * believing otherwise.
 */

type FinanceDocument = {
  kind: 'invoice' | 'receipt';
  id: string;
  reference: string;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  issuedAt: string;
  effectiveAt: string | null;
  method: string | null;
  note: string | null;
};

const METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/**
 * Turn cents typed as a major-unit string into an integer.
 *
 * `Math.round` rather than a truncation, because 49.99 parses to
 * 4998.999999999999 in binary floating point and truncating it bills the
 * subscriber a cent less than the invoice says.
 */
function toCents(input: string): number | null {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function FinanceDocumentTable({ subscriberId }: { subscriberId: string }) {
  const [documents, setDocuments] = useState<FinanceDocument[] | null>(null);
  const [outstandingCents, setOutstandingCents] = useState(0);
  const [currency, setCurrency] = useState('USD');
  const [busy, setBusy] = useState(false);

  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [invoiceAmount, setInvoiceAmount] = useState('');
  const [invoiceDueAt, setInvoiceDueAt] = useState('');

  const [payFor, setPayFor] = useState<FinanceDocument | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('bank_transfer');
  const [payRef, setPayRef] = useState('');
  const [payNote, setPayNote] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/platform/subscribers/${subscriberId}/finance`);
      setDocuments(data.documents);
      setOutstandingCents(data.outstandingCents ?? 0);
      const first = (data.documents as FinanceDocument[])[0];
      if (first) setCurrency(first.currency);
    } catch {
      toast.error('Could not load the finance ledger');
      setDocuments([]);
    }
  }, [subscriberId]);

  useEffect(() => { load(); }, [load]);

  const issueInvoice = async () => {
    const amountCents = toCents(invoiceAmount);
    if (amountCents === null) return toast.error('Enter an amount greater than zero');

    setBusy(true);
    try {
      await api.post(`/api/platform/subscribers/${subscriberId}/invoices`, {
        amountCents,
        currency,
        dueAt: invoiceDueAt || null,
      });
      toast.success('Invoice issued');
      setInvoiceOpen(false);
      setInvoiceAmount('');
      setInvoiceDueAt('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error ?? 'Could not issue the invoice');
    } finally {
      setBusy(false);
    }
  };

  const recordPayment = async () => {
    if (!payFor) return;
    const amountCents = toCents(payAmount);
    if (amountCents === null) return toast.error('Enter an amount greater than zero');

    setBusy(true);
    try {
      const { data } = await api.post(
        `/api/platform/subscribers/${subscriberId}/invoices/${payFor.id}/payments`,
        { amountCents, method: payMethod, externalRef: payRef || null, note: payNote || null },
      );
      toast.success(`Receipt ${data.receipt.reference} issued`);
      setPayFor(null);
      setPayAmount('');
      setPayRef('');
      setPayNote('');
      await load();
    } catch (err: any) {
      // The server's message names the actual problem — an overpayment says by
      // how much, a settled invoice says so. Replacing it with "failed" throws
      // away the only part that tells the owner what to do differently.
      toast.error(err?.response?.data?.error ?? 'Could not record the payment');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Download a document or the ledger.
   *
   * Fetched through the api client rather than linked directly: the platform
   * token lives in a header, and a plain `<a href>` would arrive unauthenticated
   * and download the 401 body as a file.
   */
  const download = async (url: string, filename: string) => {
    try {
      const response = await api.get(url, { responseType: 'blob' });
      const href = URL.createObjectURL(response.data as Blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch {
      toast.error('Could not download the document');
    }
  };

  const openPayment = (invoice: FinanceDocument) => {
    setPayFor(invoice);
    // Pre-filled with the balance, which is what is being paid nearly every
    // time. Editable for a part payment.
    setPayAmount(((invoice.amountCents - invoice.amountPaidCents) / 100).toFixed(2));
    setPayMethod('bank_transfer');
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Wallet className="h-4 w-4 text-primary" />
          <span className="font-medium">Finance</span>
          {outstandingCents > 0 && (
            <Badge variant="destructive" className="font-mono tabular-nums">
              {money(outstandingCents, currency)} outstanding
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setInvoiceOpen(true)}>
            <Plus className="me-1.5 h-3.5 w-3.5" />
            Issue invoice
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!documents?.length}
            onClick={() =>
              download(
                `/api/platform/subscribers/${subscriberId}/finance-export.csv`,
                `finance-${subscriberId}.csv`,
              )
            }
          >
            <Download className="me-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {documents === null ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading the ledger…
        </div>
      ) : documents.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Nothing billed yet. Issue an invoice to start this subscriber&apos;s ledger.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-start font-medium">Document</th>
                <th className="px-3 py-2 text-start font-medium">Date</th>
                <th className="px-3 py-2 text-end font-medium">Amount</th>
                <th className="px-3 py-2 text-start font-medium">Status</th>
                <th className="px-3 py-2 text-end font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const outstanding = doc.amountCents - doc.amountPaidCents;
                const settled = doc.kind === 'invoice' && outstanding <= 0;

                return (
                  <tr key={`${doc.kind}-${doc.id}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {doc.kind === 'receipt' ? (
                          <Receipt className="h-3.5 w-3.5 shrink-0 text-success" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-mono tabular-nums">{doc.reference}</span>
                      </div>
                      {doc.method && (
                        <span className="ms-5 text-micro text-muted-foreground">
                          {METHODS.find((m) => m.value === doc.method)?.label ?? doc.method}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">
                      {day(doc.effectiveAt ?? doc.issuedAt)}
                    </td>
                    <td className="px-3 py-2 text-end font-mono tabular-nums">
                      {money(doc.amountCents, doc.currency)}
                      {doc.kind === 'invoice' && doc.amountPaidCents > 0 && !settled && (
                        <div className="text-micro text-muted-foreground">
                          {money(outstanding, doc.currency)} left
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={
                          doc.kind === 'receipt' || settled ? 'default' : 'secondary'
                        }
                      >
                        {doc.kind === 'receipt' ? 'Paid' : settled ? 'Settled' : doc.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {doc.kind === 'invoice' && !settled && (
                          <Button size="sm" variant="ghost" onClick={() => openPayment(doc)}>
                            Record payment
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            download(
                              `/api/platform/subscribers/${subscriberId}/finance/${doc.kind}/${doc.id}`,
                              `${doc.reference}.html`,
                            )
                          }
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/*
        Said once, plainly, where the documents are. An owner who assumes these
        satisfy their tax authority will find out at the worst possible moment.
      */}
      <p className="text-micro text-muted-foreground">
        Invoices and receipts issued here are records of amounts due and payments
        received. They are not tax invoices and carry no fiscal numbering.
      </p>

      <Dialog open={invoiceOpen} onOpenChange={setInvoiceOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Issue an invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Amount ({currency})</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                dir="ltr"
                value={invoiceAmount}
                onChange={(e) => setInvoiceAmount(e.target.value)}
                placeholder="49.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Due date (optional)</Label>
              <Input
                type="date"
                dir="ltr"
                value={invoiceDueAt}
                onChange={(e) => setInvoiceDueAt(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceOpen(false)}>Cancel</Button>
            <Button onClick={issueInvoice} disabled={busy}>
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              Issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!payFor} onOpenChange={(open) => !open && setPayFor(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
          </DialogHeader>
          {payFor && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Against{' '}
                <span className="font-mono tabular-nums text-foreground">{payFor.reference}</span>
                {' · '}
                {money(payFor.amountCents - payFor.amountPaidCents, payFor.currency)} outstanding
              </p>
              <div className="space-y-1.5">
                <Label className="text-xs">Amount ({payFor.currency})</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  dir="ltr"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Method</Label>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                >
                  {METHODS.map((method) => (
                    <option key={method.value} value={method.value}>{method.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Payment reference (optional)</Label>
                <Input
                  dir="ltr"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="Transfer id, cheque number"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Note (optional)</Label>
                <Input value={payNote} onChange={(e) => setPayNote(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayFor(null)}>Cancel</Button>
            <Button onClick={recordPayment} disabled={busy}>
              {busy && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              Record and issue receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
