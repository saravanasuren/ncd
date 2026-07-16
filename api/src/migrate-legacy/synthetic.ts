/**
 * migrate-legacy/synthetic.ts — a fully SYNTHETIC old-app book (NO real data),
 * shaped exactly like PgLegacySource's output (old column names), used to prove
 * the pipeline end-to-end. Names/PANs/amounts are invented.
 *
 * The book is deliberately crafted to exercise every branch:
 *   - an Active application with paid rows ≤ anchor + scheduled rows > anchor
 *     (freeze + recompute), a second Active app, and a Redeemed app (frozen whole)
 *   - staff / agent / referrer incentive accruals
 *   - roles that must be MAPPED (wealth_manager, branch_executive)
 */
import type { LegacySource, Row } from './source.js';

export class SyntheticLegacySource implements LegacySource {
  label() { return 'synthetic (no real data)'; }

  async roles(): Promise<Row[]> {
    return [
      { id: 1, name: 'super_admin' },
      { id: 2, name: 'admin' },
      { id: 3, name: 'wealth_manager' },
      { id: 4, name: 'branch_executive' },
      { id: 5, name: 'agent' },
    ];
  }
  async branches(): Promise<Row[]> {
    return [
      { id: 1, code: 'HO', name: 'Head Office', city: 'Coimbatore', state: 'TN', is_active: true },
      { id: 2, code: 'ERD', name: 'Erode', city: 'Erode', district: 'Erode', state: 'TN', is_active: true },
    ];
  }
  async users(): Promise<Row[]> {
    return [
      { id: 1, email: 'sa@test.local', password_hash: 'x', full_name: 'SA Test', role_id: 1, branch_id: 1, is_active: true },
      { id: 2, email: 'be@test.local', password_hash: 'x', full_name: 'BE Test', role_id: 4, branch_id: 2, reports_to_user_id: 1, is_active: true },
    ];
  }
  async agents(): Promise<Row[]> {
    return [
      { id: 1, agent_code: 'AGT001', full_name: 'Agent One', phone: '9000000001', email: 'agent@test.local', commission_eligibility_status: 'Approved', payout_bank_name: 'SBI', payout_account_number: '111', payout_ifsc: 'SBIN0000001', is_active: true },
    ];
  }
  async banks(): Promise<Row[]> {
    return [{ id: 1, account_label: 'Collection', bank_name: 'Federal Bank', account_number: '19820200007409', ifsc: 'FDRL0001982', is_collection_account: true, is_disbursement_account: true, is_active: true }];
  }
  async tdsRules(): Promise<Row[]> {
    return [{ id: 1, name: 'Standard 10%', rate_pct: 10, threshold_amount: null, is_active: true }];
  }
  async holidays(): Promise<Row[]> { return []; }
  async companyProfile(): Promise<Row[]> {
    return [{ id: 1, legal_name: 'Dhanam Investment and Finance Private Limited', legal_name_short: 'Dhanam', tan: 'CMBK00000K', tan_holder_name: 'Kiara Microcredit Private Limited', tan_amendment_pending: true, signatory_name: 'Test Signatory', signatory_designation: 'CEO' }];
  }
  async schemes(): Promise<Row[]> {
    return [{ id: 1, code: 'NCD-36M', name: '36 Month Monthly 12%', tenure_months: 36, payout_frequency: 'Monthly', coupon_rate_pct: 12, face_value: 100000, min_ticket_amount: 100000, multiple_of: 100000, day_count_convention: 'Actual365', commission_type: 'OneTime', tds_rule_id: 1, is_active: true }];
  }
  async series(): Promise<Row[]> {
    return [{ id: 1, code: 'NCD-TEST', name: 'Test Series', status: 'Allotted', face_value: 100000, deemed_date_of_allotment: '2024-07-28', isin_number: 'INTEST0001', open_date: '2024-07-01', allotted_at: '2024-07-28T00:00:00Z' }];
  }
  async seriesSchemes(): Promise<Row[]> { return [{ series_id: 1, scheme_id: 1 }]; }
  async leads(): Promise<Row[]> {
    return [{ id: 1, full_name: 'Lead One', phone: '9000000009', city: 'Erode', district: 'Erode', source: 'Walk-in', lead_status: 'New', created_by_user_id: 2 }];
  }
  async customers(): Promise<Row[]> {
    return [
      { id: 1, customer_code: 'DHN000001', full_name: 'Alpha Test', pan: 'AAAAA0001A', date_of_birth: '1970-01-01', gender: 'M', phone_primary: '9000000001', email: 'alpha@test.local', address_line1: '1 Test St', city: 'Erode', district: 'Erode', state: 'TN', is_nri: false, tds_applicable: true, kyc_status: 'Verified', creation_status: 'Approved', enrolled_by_user_id: 2, branch_id: 2, is_active: true },
      { id: 2, customer_code: 'DHN000002', full_name: 'Bravo Test', pan: 'AAAAA0002A', date_of_birth: '1965-05-05', gender: 'F', phone_primary: '9000000002', city: 'Salem', district: 'Salem', state: 'TN', tds_applicable: true, kyc_status: 'Verified', creation_status: 'Approved', enrolled_by_user_id: 2, branch_id: 2, is_active: true },
      { id: 3, customer_code: 'DHN000003', full_name: 'Charlie Test', pan: 'AAAAA0003A', date_of_birth: '1958-03-03', phone_primary: '9000000003', city: 'Coimbatore', district: 'Coimbatore', state: 'TN', tds_applicable: true, kyc_status: 'Verified', creation_status: 'Approved', enrolled_by_user_id: 2, branch_id: 1, is_active: true },
    ];
  }
  async customerBankAccounts(): Promise<Row[]> {
    return [
      { id: 1, customer_id: 1, bank_name: 'SBI', bank_account_number: '111122223333', bank_ifsc: 'SBIN0000001', bank_beneficiary_name: 'Alpha Test', is_active: true, penny_drop_status: 'Verified' },
      { id: 2, customer_id: 2, bank_name: 'HDFC', bank_account_number: '444455556666', bank_ifsc: 'HDFC0000002', is_active: true, penny_drop_status: 'Verified' },
      { id: 3, customer_id: 3, bank_name: 'ICICI', bank_account_number: '777788889999', bank_ifsc: 'ICIC0000003', is_active: true, penny_drop_status: 'Verified' },
    ];
  }
  async nominees(): Promise<Row[]> {
    return [{ id: 1, customer_id: 1, full_name: 'Nominee One', relationship: 'Spouse', share_pct: 100, date_of_birth: '1972-02-02' }];
  }
  async jointHolders(): Promise<Row[]> { return []; }

  async applications(): Promise<Row[]> {
    return [
      { id: 1, application_no: 'APP-2024-000001', customer_id: 1, series_id: 1, status: 'Active', total_amount: 1000000, amount_received: 1000000, date_money_received: '2024-07-20', collection_method: 'NEFT', allotment_date: '2024-07-28', maturity_date: '2027-07-28', enrolled_by_user_id: 2, customer_was_new_at_creation: true },
      { id: 2, application_no: 'APP-2024-000002', customer_id: 3, series_id: 1, status: 'Redeemed', total_amount: 500000, amount_received: 500000, allotment_date: '2024-07-28', maturity_date: '2027-07-28', redemption_date: '2025-06-28', enrolled_by_user_id: 2 },
      { id: 3, application_no: 'APP-2025-000003', customer_id: 2, series_id: 1, status: 'Active', total_amount: 200000, amount_received: 200000, allotment_date: '2025-01-28', maturity_date: '2028-01-28', enrolled_by_user_id: 2 },
    ];
  }
  async applicationLines(): Promise<Row[]> {
    return [
      { id: 1, application_id: 1, scheme_id: 1, coupon_rate_pct: 12, tenure_months: 36, payout_frequency: 'Monthly', day_count_convention: 'Actual365', interest_start_date: '2024-07-28', maturity_date: '2027-07-28', amount: 1000000, outstanding_amount: 1000000, status: 'Active' },
      { id: 2, application_id: 2, scheme_id: 1, coupon_rate_pct: 12, tenure_months: 36, payout_frequency: 'Monthly', day_count_convention: 'Actual365', interest_start_date: '2024-07-28', maturity_date: '2027-07-28', amount: 500000, outstanding_amount: 0, status: 'Matured' },
      { id: 3, application_id: 3, scheme_id: 1, coupon_rate_pct: 12, tenure_months: 36, payout_frequency: 'Monthly', day_count_convention: 'Actual365', interest_start_date: '2025-01-28', maturity_date: '2028-01-28', amount: 200000, outstanding_amount: 200000, status: 'Active' },
    ];
  }
  async schedule(): Promise<Row[]> {
    return [
      // Line 1 (Active): two paid rows ≤ anchor, two scheduled rows > anchor (to drop+regen)
      { id: 101, application_line_id: 1, customer_id: 1, due_date: '2026-05-28', due_type: 'Interest', gross_amount: 10000, tds_amount: 1000, net_amount: 9000, status: 'Paid', paid_at: '2026-05-28' },
      { id: 102, application_line_id: 1, customer_id: 1, due_date: '2026-06-28', due_type: 'Interest', gross_amount: 10000, tds_amount: 1000, net_amount: 9000, status: 'Paid', paid_at: '2026-06-28' },
      { id: 103, application_line_id: 1, customer_id: 1, due_date: '2026-07-28', due_type: 'Interest', gross_amount: 10000, tds_amount: 1000, net_amount: 9000, status: 'Scheduled' },
      { id: 104, application_line_id: 1, customer_id: 1, due_date: '2027-07-28', due_type: 'Redemption', gross_amount: 1000000, tds_amount: 0, net_amount: 1000000, status: 'Scheduled' },
      // Line 2 (Matured/Redeemed): all paid, frozen whole
      { id: 201, application_line_id: 2, customer_id: 3, due_date: '2025-05-28', due_type: 'Interest', gross_amount: 5000, tds_amount: 500, net_amount: 4500, status: 'Paid', paid_at: '2025-05-28' },
      { id: 202, application_line_id: 2, customer_id: 3, due_date: '2025-06-28', due_type: 'Redemption', gross_amount: 500000, tds_amount: 0, net_amount: 500000, status: 'Paid', paid_at: '2025-06-28' },
      // Line 3 (Active): one paid ≤ anchor, one scheduled > anchor
      { id: 301, application_line_id: 3, customer_id: 2, due_date: '2026-06-28', due_type: 'Interest', gross_amount: 2000, tds_amount: 200, net_amount: 1800, status: 'Paid', paid_at: '2026-06-28' },
      { id: 302, application_line_id: 3, customer_id: 2, due_date: '2026-07-28', due_type: 'Interest', gross_amount: 2000, tds_amount: 200, net_amount: 1800, status: 'Scheduled' },
    ];
  }
  async redemptions(): Promise<Row[]> {
    return [{ id: 1, request_no: 'RED-2025-000001', application_id: 2, total_principal: 500000, penalty_amount: 0, net_payment_amount: 500000, broken_period_interest: 0, redemption_date: '2025-06-28', status: 'NEFTGenerated', created_by_user_id: 1, created_at: '2025-06-20' }];
  }
  async incentiveAccruals(): Promise<Row[]> {
    return [
      { id: 1, _payee_type: 'staff', _payee_ref: 2, application_id: 1, applied_pct: 2.0, amount: 20000, accrual_date: '2024-07-28' },
      { id: 2, _payee_type: 'agent', _payee_ref: 1, application_id: 3, applied_pct: 2.0, amount: 4000, accrual_date: '2025-01-28' },
      { id: 3, _payee_type: 'referrer', _payee_ref: 'john doe', referrer_name_display: 'John Doe', application_id: 1, applied_pct: 2.0, amount: 20000, accrual_date: '2024-07-28' },
    ];
  }
  async close() { /* nothing */ }
}
