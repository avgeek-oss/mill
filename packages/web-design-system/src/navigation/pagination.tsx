"use client";

import {
  Pagination as HeroPagination,
  type PaginationRootProps,
} from "@heroui/react";
import { Fragment } from "react";
import { Button } from "../button.js";

type PaginationProps = Omit<PaginationRootProps, "children"> & {
  page: number;
  totalPages: number;
  isDisabled?: boolean;
  onPageChange: (page: number) => void;
};

export function Pagination({
  page,
  totalPages,
  isDisabled = false,
  onPageChange,
  ...props
}: PaginationProps) {
  const visiblePages = Array.from(
    new Set([1, page - 1, page, page + 1, totalPages]),
  )
    .filter((number) => number >= 1 && number <= totalPages)
    .sort((left, right) => left - right);

  return (
    <HeroPagination {...props}>
      <HeroPagination.Content className="flex-wrap">
        <HeroPagination.Item>
          <Button
            variant="secondary"
            aria-label="Previous page"
            className="max-sm:w-[34px] max-sm:p-0 pointer-fine:max-sm:w-8"
            isDisabled={isDisabled || page === 1}
            onPress={() => onPageChange(page - 1)}
          >
            <HeroPagination.PreviousIcon />
            <span className="hidden sm:inline">Previous</span>
          </Button>
        </HeroPagination.Item>
        {visiblePages.map((number, index) => (
          <Fragment key={number}>
            {index > 0 && number - visiblePages[index - 1]! > 1 && (
              <HeroPagination.Item>
                <HeroPagination.Ellipsis />
              </HeroPagination.Item>
            )}
            <HeroPagination.Item>
              <Button
                aria-label={`Go to page ${number}`}
                aria-current={number === page ? "page" : undefined}
                variant={number === page ? "primary" : "secondary"}
                isIconOnly
                isDisabled={isDisabled}
                onPress={() => onPageChange(number)}
              >
                {number}
              </Button>
            </HeroPagination.Item>
          </Fragment>
        ))}
        <HeroPagination.Item>
          <Button
            variant="secondary"
            aria-label="Next page"
            className="max-sm:w-[34px] max-sm:p-0 pointer-fine:max-sm:w-8"
            isDisabled={isDisabled || page === totalPages}
            onPress={() => onPageChange(page + 1)}
          >
            <span className="hidden sm:inline">Next</span>
            <HeroPagination.NextIcon />
          </Button>
        </HeroPagination.Item>
      </HeroPagination.Content>
    </HeroPagination>
  );
}
